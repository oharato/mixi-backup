/**
 * Unit tests for mixi_backup.ts – no real network calls.
 */

import * as fs from "fs";
import * as path from "path";

import {
  CookieJar,
  sessionFetch,
  extractOwnerId,
  parseDiaryListPage,
  hasNextPage,
  extractDiaryDetail,
  MixiBackup,
  DiaryEntry,
} from "../mixi_backup";

// ---------------------------------------------------------------------------
// HTML fixtures
// ---------------------------------------------------------------------------

const LOGIN_SUCCESS_HTML = `
<html><body>
  <a href="/view_profile.pl?id=99999">マイプロフィール</a>
</body></html>`;

const DIARY_LIST_PAGE_1 = `
<html><body>
  <ul>
    <li><a href="/view_diary.pl?id=1001&owner_id=99999">日記タイトル1</a></li>
    <li><a href="/view_diary.pl?id=1002&owner_id=99999">日記タイトル2</a></li>
  </ul>
  <a href="/list_diary.pl?page=2">次のページ</a>
</body></html>`;

const DIARY_LIST_PAGE_2 = `
<html><body>
  <ul>
    <li><a href="/view_diary.pl?id=1003&owner_id=99999">日記タイトル3</a></li>
  </ul>
</body></html>`;

const DIARY_DETAIL_HTML = `
<html><body>
  <div class="diaryBody">これはテスト本文です。</div>
  <span class="date">2024-01-01 10:00</span>
  <img src="https://photo.mixi.jp/img/photo1.jpg" />
  <div class="comment">
    <span class="name">友達A</span>
    <div class="body">コメント本文1</div>
    <span class="date">2024-01-01 11:00</span>
  </div>
  <div class="comment">
    <span class="name">友達B</span>
    <div class="body">コメント本文2</div>
    <span class="date">2024-01-01 12:00</span>
  </div>
</body></html>`;

// ---------------------------------------------------------------------------
// Helper: build a minimal Response-like object (no real fetch needed)
// ---------------------------------------------------------------------------

function makeResponse(
  body: string,
  { url = "https://mixi.jp/home.pl", status = 200, cookies = [] as string[] } = {}
): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  cookies.forEach((c) => headers.append("Set-Cookie", c));

  const resp = new Response(body, { status, headers });
  // Override the read-only url property so tests can inspect it
  Object.defineProperty(resp, "url", { value: url });
  return resp;
}

// ---------------------------------------------------------------------------
// CookieJar
// ---------------------------------------------------------------------------

describe("CookieJar", () => {
  test("ingests Set-Cookie headers and returns a Cookie header string", () => {
    const jar = new CookieJar();
    const resp = makeResponse("", {
      cookies: ["session_id=abc123; Path=/; HttpOnly", "user=42; Path=/"],
    });
    jar.ingest(resp);
    const header = jar.header();
    expect(header).toContain("session_id=abc123");
    expect(header).toContain("user=42");
  });

  test("overwrites a cookie with a newer value", () => {
    const jar = new CookieJar();
    jar.ingest(makeResponse("", { cookies: ["token=old"] }));
    jar.ingest(makeResponse("", { cookies: ["token=new"] }));
    expect(jar.header()).toBe("token=new");
  });

  test("returns empty string when no cookies stored", () => {
    const jar = new CookieJar();
    expect(jar.header()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// sessionFetch
// ---------------------------------------------------------------------------

describe("sessionFetch", () => {
  test("injects Cookie header and stores response cookies", async () => {
    const jar = new CookieJar();
    jar.ingest(makeResponse("", { cookies: ["existing=yes"] }));

    let capturedHeaders: Record<string, string> = {};
    const mockFetch = jest.fn(async (url: string, opts: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((opts.headers ?? {}) as Record<string, string>)
      );
      return makeResponse("ok", { cookies: ["new_cookie=xyz"] });
    });

    const resp = await sessionFetch(jar, "https://mixi.jp/", {}, mockFetch as typeof fetch);
    expect(capturedHeaders["Cookie"]).toContain("existing=yes");
    expect(jar.header()).toContain("new_cookie=xyz");
    expect(await resp.text()).toBe("ok");
  });

  test("throws on non-ok status", async () => {
    const mockFetch = jest.fn(async () =>
      makeResponse("Unauthorized", { status: 401 })
    );
    await expect(
      sessionFetch(new CookieJar(), "https://mixi.jp/", {}, mockFetch as typeof fetch)
    ).rejects.toThrow("HTTP 401");
  });
});

// ---------------------------------------------------------------------------
// extractOwnerId
// ---------------------------------------------------------------------------

describe("extractOwnerId", () => {
  test("reads owner_id from response URL query string", () => {
    expect(extractOwnerId("", "https://mixi.jp/home.pl?owner_id=12345")).toBe(
      "12345"
    );
  });

  test("reads id from a profile link in the HTML", () => {
    const html = `<a href="/view_profile.pl?id=55555">プロフィール</a>`;
    expect(extractOwnerId(html, "https://mixi.jp/home.pl")).toBe("55555");
  });

  test("reads owner_id from a hidden input", () => {
    const html = `<input type="hidden" name="owner_id" value="77777" />`;
    expect(extractOwnerId(html, "https://mixi.jp/home.pl")).toBe("77777");
  });

  test("returns null when nothing found", () => {
    expect(extractOwnerId("<html></html>", "https://mixi.jp/home.pl")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDiaryListPage
// ---------------------------------------------------------------------------

describe("parseDiaryListPage", () => {
  test("extracts diary entries from page HTML", () => {
    const entries = parseDiaryListPage(DIARY_LIST_PAGE_1, "99999");
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("1001");
    expect(entries[1].id).toBe("1002");
    expect(entries[0].ownerId).toBe("99999");
  });

  test("does not produce duplicates for repeated links on the same page", () => {
    const html = `
      <a href="/view_diary.pl?id=2001&owner_id=99999">dup</a>
      <a href="/view_diary.pl?id=2001&owner_id=99999">dup</a>`;
    const entries = parseDiaryListPage(html, "99999");
    expect(entries).toHaveLength(1);
  });

  test("uses fallback owner id when not present in href", () => {
    const html = `<a href="/view_diary.pl?id=3001">日記</a>`;
    const entries = parseDiaryListPage(html, "fallback123");
    expect(entries[0].ownerId).toBe("fallback123");
  });
});

// ---------------------------------------------------------------------------
// hasNextPage
// ---------------------------------------------------------------------------

describe("hasNextPage", () => {
  test("returns true when a '次' link is present", () => {
    expect(hasNextPage(DIARY_LIST_PAGE_1)).toBe(true);
  });

  test("returns false when no next-page link exists", () => {
    expect(hasNextPage(DIARY_LIST_PAGE_2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractDiaryDetail
// ---------------------------------------------------------------------------

describe("extractDiaryDetail", () => {
  const baseEntry: DiaryEntry = {
    id: "1001",
    ownerId: "99999",
    title: "日記タイトル1",
    url: "https://mixi.jp/view_diary.pl?id=1001&owner_id=99999",
  };

  test("extracts body text", () => {
    const result = extractDiaryDetail(DIARY_DETAIL_HTML, baseEntry);
    expect(result.bodyText).toContain("テスト本文");
  });

  test("extracts body html", () => {
    const result = extractDiaryDetail(DIARY_DETAIL_HTML, baseEntry);
    expect(result.bodyHtml).toContain("テスト本文");
  });

  test("extracts date", () => {
    const result = extractDiaryDetail(DIARY_DETAIL_HTML, baseEntry);
    expect(result.date).toContain("2024");
  });

  test("extracts photo URLs", () => {
    const result = extractDiaryDetail(DIARY_DETAIL_HTML, baseEntry);
    expect(result.photoUrls).toContain("https://photo.mixi.jp/img/photo1.jpg");
  });

  test("extracts comments with author and body", () => {
    const result = extractDiaryDetail(DIARY_DETAIL_HTML, baseEntry);
    const authors = result.comments!.map((c) => c.author);
    expect(authors).toContain("友達A");
    const bodies = result.comments!.map((c) => c.body);
    expect(bodies.some((b) => b.includes("コメント本文"))).toBe(true);
  });

  test("returns empty body when no matching element", () => {
    const result = extractDiaryDetail("<html><body></body></html>", baseEntry);
    expect(result.bodyHtml).toBe("");
    expect(result.bodyText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// MixiBackup – saveEntry
// ---------------------------------------------------------------------------

describe("MixiBackup.saveEntry", () => {
  const OUTPUT = "/tmp/mixi_ts_test_save";

  afterAll(() => {
    fs.rmSync(OUTPUT, { recursive: true, force: true });
  });

  test("writes body.html and entry.json; entry.json excludes bodyHtml", () => {
    const backup = new MixiBackup(OUTPUT);
    const entry: DiaryEntry = {
      id: "7001",
      ownerId: "99999",
      title: "テスト日記",
      url: "https://mixi.jp/view_diary.pl?id=7001&owner_id=99999",
      date: "2024-01-01",
      bodyHtml: "<div>本文</div>",
      bodyText: "本文",
      photoUrls: [],
      comments: [{ author: "A", body: "コメント", date: "2024-01-02" }],
    };

    backup.saveEntry(entry);

    const dir = path.join(OUTPUT, "diaries", "7001");
    expect(fs.existsSync(path.join(dir, "body.html"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "entry.json"))).toBe(true);

    const meta = JSON.parse(
      fs.readFileSync(path.join(dir, "entry.json"), "utf-8")
    );
    expect(meta).not.toHaveProperty("bodyHtml");
    expect(meta.title).toBe("テスト日記");
    expect(meta.comments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MixiBackup – downloadPhoto
// ---------------------------------------------------------------------------

describe("MixiBackup.downloadPhoto", () => {
  const OUTPUT = "/tmp/mixi_ts_test_photos";

  beforeAll(() => fs.mkdirSync(OUTPUT, { recursive: true }));
  afterAll(() => fs.rmSync(OUTPUT, { recursive: true, force: true }));

  test("saves a photo and returns the filename", async () => {
    const backup = new MixiBackup(OUTPUT);
    const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    const mockFetch = jest.fn(async () => {
      const resp = new Response(photoBytes);
      Object.defineProperty(resp, "url", {
        value: "https://photo.mixi.jp/img/test.jpg",
      });
      return resp;
    });

    // Inject mock fetch via the internal jar's sessionFetch by monkey-patching
    (backup as unknown as { jar: CookieJar })["jar"] = new CookieJar();
    const fname = await backup.downloadPhoto(
      "https://photo.mixi.jp/img/test.jpg",
      OUTPUT,
      mockFetch
    );
    expect(fname).toBe("test.jpg");
    expect(fs.existsSync(path.join(OUTPUT, "test.jpg"))).toBe(true);
  });

  test("returns null on network error", async () => {
    const backup = new MixiBackup(OUTPUT);
    const mockFetch = jest.fn(async () => {
      throw new Error("network error");
    });
    const fname = await backup.downloadPhoto(
      "https://photo.mixi.jp/img/fail.jpg",
      OUTPUT,
      mockFetch
    );
    expect(fname).toBeNull();
  });

  test("skips download if file already exists", async () => {
    const backup = new MixiBackup(OUTPUT);
    const existing = path.join(OUTPUT, "existing.jpg");
    fs.writeFileSync(existing, "data");
    const mockFetch = jest.fn();
    const fname = await backup.downloadPhoto(
      "https://photo.mixi.jp/img/existing.jpg",
      OUTPUT,
      mockFetch
    );
    expect(fname).toBe("existing.jpg");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
