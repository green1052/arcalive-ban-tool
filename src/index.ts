import got, {HTTPError} from "got";
import * as cheerio from "cheerio";
import {CookieJar} from "tough-cookie";
import fs from "fs";
import typia from "typia";
import {DateTime, DurationObjectUnits} from "luxon";
import * as process from "process";
import {FileCookieStore} from "tough-cookie-file-store";
import {multiselect} from "@topcli/prompts";

interface BlockedUser {
    username: string;
    reason: string;
    isArticle: boolean;
    isComment: boolean;
    articleUrl: string;
    unblockUrl: string;
    startDate: DateTime;
    endDate: DateTime;
    diff: DurationObjectUnits;
}

interface Config {
    /** 아카라이브 아이디 */
    username: string;
    /** 아카라이브 비밀번호 */
    password: string;
    /** 아카라이브 채널 슬러그 */
    slug: string;
    /** 차단 기간이 1년인 유저만 표시합니다. */
    onlyOneYear: boolean;
    /** 게시글 차단을 표시합니다. */
    showArticle: boolean;
    /** 댓글 차단을 표시합니다. */
    showComment: boolean;
    /** 차단 사유 (미설정시 기존 차단 사유 사용) */
    reason?: string;
    /** 차단 기간 초 단위로 (미설정시 1년 차단) */
    duration?: string;
    /** 해당 정규식과 일치하는 차단 사유만 표시합니다. */
    reasonRegex?: string;
    /** 해당 정규식과 일치하는 차단 사유를 제외합니다. */
    reasonExcludeRegex?: string;
    /** 해당 일보다 적은 남은 차단일만 표시합니다. */
    lessThanDays?: number;
}

interface Cache {
    articleDelete: string[];
}

if (!fs.existsSync("config.json")) {
    console.error("config.json 파일이 없습니다.");
    process.exit();
}

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

if (!typia.is<Config>(config)) {
    console.error("config.json 파일이 잘못되었습니다.");
    process.exit();
}

if (!fs.existsSync("cache.json")) {
    fs.writeFileSync("cache.json", JSON.stringify({articleDelete: []}));
}

const cache = JSON.parse(fs.readFileSync("cache.json", "utf8"));

if (!typia.is<Cache>(cache)) {
    console.error("cache.json 파일이 잘못되었습니다.");
    process.exit();
}

const cookieJar = new CookieJar(new FileCookieStore("cookies.json"));

const client = got.extend({
    prefixUrl: "https://arca.live",
    cookieJar,
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0",
        Origin: "https://arca.live"
    }
});

const login = async (username: string, password: string) => {
    console.log(`[login]: ${username} 유저 로그인 중...`);

    const response = await client("u/login");
    const $ = cheerio.load(response.body);
    const _csrf = $("input[name=_csrf]").val() as string;

    await client("u/login", {
        method: "POST",
        followRedirect: false,
        form: {
            _csrf,
            goto: "/",
            username,
            password
        }
    });

    console.log(`[login]: ${username} 유저 로그인 완료`);
};

await login(config.username, config.password);

const getBlockUsers = async (slug: string, before?: string): Promise<BlockedUser[]> => {
    console.log(`[getBlockUsers]: ${slug} 채널 차단 유저 목록 가져오는 중... before: ${before ?? "없음"}`);

    const result: BlockedUser[] = [];

    const response = await client(`b/${slug}/blocked${before ? `?before=${before}` : ""}`);
    const $ = cheerio.load(response.body);

    for (const element of $(".blocked-item")) {
        const $element = cheerio.load(element);

        const username = $element(".target:not(:has(.user-info))").text() || $element(".user-info a").attr("data-filter")!;

        const a = $element("main > a");

        const reason = a.text().trim();
        const articleUrl = a.attr("href")!.trim().replace(/^\//, "");

        const url = new URL(`https://arca.live/${articleUrl}`);

        const isComment = url.hash.startsWith("#c_");

        const unblockUrl = $element(".right > a").attr("href")!.replace(/^\//, "");

        const startDate = $element(".extendableDatetime:nth-child(1) > time").attr("datetime")!;
        const endDate = $element(".extendableDatetime:nth-child(2) > time").attr("datetime")!;

        const t = DateTime.fromISO(startDate, {zone: "Asia/Seoul"});
        const t2 = DateTime.fromISO(endDate, {zone: "Asia/Seoul"});
        const diff = t2.diff(t, ["years", "months", "days"]).toObject();

        result.push({
            username,
            reason,
            articleUrl,
            isArticle: !isComment,
            isComment,
            startDate: t,
            endDate: t2,
            diff,
            unblockUrl
        });
    }

    console.log(`[getBlockUsers]: ${slug} 채널 차단 유저 목록 가져오기 완료 before: ${before ?? "없음"}`);

    const next = $(".pr-3 > .btn").attr("href");

    if (!next)
        return result;

    if (before && next.endsWith(before)) {
        return result;
    } else {
        return result.concat(await getBlockUsers(slug, next));
    }
};

const blockUser = async (slug: string, user: BlockedUser) => {
    console.log(`[blockUser]: ${user.username} 유저 차단 중... 게시글: ${user.isArticle} 댓글: ${user.isComment}`);

    try {
        const response = await client(user.articleUrl);
        const $ = cheerio.load(response.body);

        if (user.isArticle) {
            if (cache.articleDelete.includes(user.articleUrl)) {
                console.error(`[blockUser]: cache ${user.articleUrl} 게시글이 삭제됐습니다.`);
                return;
            }

            try {
                console.log(`[blockUser]: ${user.username} 유저 게시글 차단 해제 중...`);
                await client(user.unblockUrl);
                console.log(`[blockUser]: ${user.username} 유저 게시글 차단 해제 완료`);

                console.log(`[blockUser]: ${user.username} 유저 게시글 차단 중...`);
                const _csrf = $("input[name=_csrf]").val() as string;

                await client(user.articleUrl.replace(new RegExp(`b/${slug}/`), `b/${slug}/block/article/`), {
                    method: "POST",
                    form: {
                        _csrf,
                        description: config.reason || user.reason,
                        until: config.duration || "31536000"
                    }
                });
                console.log(`[blockUser]: ${user.username} 유저 게시글 차단 완료`);
            } catch (e) {
                if (e instanceof HTTPError) {
                    if (e.response.statusCode === 405) {
                        console.log(`[blockUser]: ${user.username} 유저 차단 성공`);
                        return;
                    }

                    if (e.response.statusCode == 429) {
                        console.error(`[blockUser]: ${user.username} 유저 게시글 차단 실패 오류: 캡챠 발생`);
                        process.exit();
                    }

                    return;
                }

                console.error(`[blockUser]: ${user.username} 유저 게시글 차단 실패 오류: ${e}`);
            }
        }
    } catch (e) {
        if (e instanceof HTTPError) {
            if (e.response.statusCode === 404) {
                console.error(`[blockUser]: ${user.articleUrl} 게시글이 삭제됐습니다.`);
                cache.articleDelete.push(user.articleUrl);
                return;
            }

            console.error(`[blockUser]: ${e}`);
            return;
        }

        console.error(`[blockUser]: ${e}`);
    }
};

const result =
    (await getBlockUsers(config.slug))
        .filter((user) => {
            if (config.onlyOneYear && user.diff.years !== 1)
                return false;

            if (config.showArticle && !user.isArticle)
                return false;

            if (config.showComment && !user.isComment)
                return false;

            if (config.reasonRegex && new RegExp(config.reasonRegex).test(user.reason))
                return false;

            if (config.reasonExcludeRegex && !new RegExp(config.reasonExcludeRegex).test(user.reason))
                return false;

            if (config.lessThanDays && user.endDate.diff(DateTime.local({zone: "Asia/Seoul"}), "days").days > config.lessThanDays)
                return false;

            return true;
        });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const response = await multiselect("차단 유저 목록", {
    choices: result.map((user) => ({
        label: `${user.username} [${user.reason}] [${user.isArticle ? "게시글" : "댓글"} 차단] [${Math.floor(user.endDate.diff(DateTime.local({zone: "Asia/Seoul"}), "days").days)}일 남음]`,
        value: user
    }))
});

for (const user of response) {
    // @ts-ignore
    await blockUser(config.slug, user);
    await sleep(10000);
}

fs.writeFileSync("cache.json", JSON.stringify(cache));

// await client("u/logout");