/**
 * mixi_backup.ts
 *
 * Back up your mixi diary entries, photos, and comments.
 *
 * Usage (after `npm run build`):
 *   node dist/mixi_backup.js --email you@example.com --password yourpass [--output ./backup]
 */

import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";

const BASE_URL = "https://mixi.jp";
const LOGIN_URL = `${BASE_URL}/login.pl`;
const DIARY_LIST_URL = `${BASE_URL}/list_diary.pl`;
const VIEW_DIARY_URL = `${BASE_URL}/view_diary.pl`;

/** Milliseconds to wait between requests to avoid hammering the server. */
const REQUEST_INTERVAL_MS = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiaryEntry {
  id: string;
  ownerId: string;
  title: string;
  url: string;
  date?: string;
  bodyHtml?: string;
  bodyText?: string;
  photoUrls?: string[];
  localPhotos?: string[];
  comments?: Comment[];
}

export interface Comment {
  author: string;
  body: string;
  date: string;
}

// ---------------------------------------------------------------------------
// Cookie jar — thin wrapper around the built-in fetch
// ---------------------------------------------------------------------------

/**
 * Minimal cookie jar that stores cookies and injects them into every request.
 * This replaces axios / node-fetch so we only use the Node 20 built-in fetch.
 */
export class CookieJar {
  private cookies: Map<string, string> = new Map();

  /** Parse Set-Cookie headers from a Response and store the values. */
  ingest(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const pair = cookie.split(";")[0].trim();
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      this.cookies.set(name, value);
    }
  }

  /** Return a Cookie header value for the current jar. */
  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a fetch request, automatically injecting the session cookies and
 * storing any new cookies from the response.
 *
 * An optional `fetchFn` can be injected (e.g. in tests) instead of the
 * global `fetch`.
 */
export async function sessionFetch(
  jar: CookieJar,
  url: string,
  options: RequestInit = {},
  fetchFn: FetchFn = fetch
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    Cookie: jar.header(),
    ...(options.headers as Record<string, string>),
  };

  const response = await fetchFn(url, { ...options, headers });
  jar.ingest(response);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`);
  }
  return response;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

export function extractOwnerId(html: string, responseUrl: string): string | null {
  // 1. Try query-string of the response URL
  try {
    const u = new URL(responseUrl);
    const id = u.searchParams.get("owner_id");
    if (id) return id;
  } catch {
    // ignore
  }

  // 2. Scrape a profile link
  const $ = load(html);
  const profileLink = $("a[href*='view_profile.pl']").first().attr("href") ?? "";
  const m = profileLink.match(/[?&]id=(\d+)/);
  if (m) return m[1];

  // 3. Hidden input
  const hidden = $("input[name='owner_id']").first().val();
  if (hidden) return String(hidden);

  return null;
}

export function parseDiaryListPage(
  html: string,
  fallbackOwnerId: string
): DiaryEntry[] {
  const $ = load(html);
  const seen = new Set<string>();
  const entries: DiaryEntry[] = [];

  $("a[href*='view_diary.pl']").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const mId = href.match(/[?&]id=(\d+)/);
    const mOwner = href.match(/[?&]owner_id=(\d+)/);
    if (!mId) return;
    const id = mId[1];
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      ownerId: mOwner ? mOwner[1] : fallbackOwnerId,
      title: $(el).text().trim(),
      url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
    });
  });

  return entries;
}

export function hasNextPage(html: string): boolean {
  const $ = load(html);
  return $("a").filter((_i, el) => /次|next/i.test($(el).text())).length > 0;
}

export function extractDiaryDetail(
  html: string,
  entry: DiaryEntry
): DiaryEntry {
  const $ = load(html);

  // Body
  const bodyEl =
    $("[class*='diaryBody'], [class*='diary-body'], [class*='contents']").first();
  const bodyHtml = bodyEl.html() ?? "";
  const bodyText = bodyEl.text().trim();

  // Date
  const dateEl = $("[class*='date'], [class*='time'], [class*='timestamp']").first();
  const date = dateEl.text().trim();

  // Photos
  const photoUrls: string[] = [];
  $("img").each((_i, el) => {
    const src = $(el).attr("src") ?? "";
    if (src.startsWith("http") && /photo|img|image/i.test(src)) {
      if (!photoUrls.includes(src)) photoUrls.push(src);
    }
  });

  // Comments
  const comments = extractComments($);

  return {
    ...entry,
    date,
    bodyHtml,
    bodyText,
    photoUrls,
    comments,
  };
}

function extractComments($: CheerioAPI): Comment[] {
  const comments: Comment[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $("[class*='comment'], [class*='Comment']").each((_i: number, item: any) => {
    const author =
      $(item).find("[class*='name'], [class*='author'], [class*='nick']").first().text().trim();
    const body =
      $(item).find("[class*='body'], [class*='text'], [class*='content']").first().text().trim();
    const date =
      $(item).find("[class*='date'], [class*='time']").first().text().trim();
    if (author || body) {
      comments.push({ author, body, date });
    }
  });
  return comments;
}

/** Minimal fetch signature used internally so we avoid the overly broad built-in. */
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class MixiBackup {
  private jar = new CookieJar();
  private ownerId: string | null = null;

  constructor(private outputDir: string = "./backup") {}

  // ── Auth ────────────────────────────────────────────────────────────────

  async login(email: string, password: string): Promise<void> {
    console.log(`Logging in as ${email} …`);
    const body = new URLSearchParams({
      next_url: "/home.pl",
      email,
      password,
    });

    const response = await sessionFetch(this.jar, LOGIN_URL, {
      method: "POST",
      body,
      redirect: "follow",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const html = await response.text();
    const finalUrl = response.url;

    if (!finalUrl.includes("home.pl") && !finalUrl.includes("mixi_id")) {
      throw new Error("ログインに失敗しました。メールアドレスとパスワードを確認してください。");
    }

    this.ownerId = extractOwnerId(html, finalUrl);
    if (!this.ownerId) {
      throw new Error("ログイン後にowner_idを取得できませんでした。");
    }
    console.log(`ログイン成功 (owner_id=${this.ownerId})`);
  }

  // ── Diary list ──────────────────────────────────────────────────────────

  async fetchDiaryList(): Promise<DiaryEntry[]> {
    const entries: DiaryEntry[] = [];
    let page = 1;

    while (true) {
      console.log(`日記一覧を取得中 (page ${page}) …`);
      const url = `${DIARY_LIST_URL}?page=${page}&owner_id=${this.ownerId}`;
      const response = await sessionFetch(this.jar, url);
      const html = await response.text();

      const newEntries = parseDiaryListPage(html, this.ownerId!);
      if (newEntries.length === 0) break;
      entries.push(...newEntries);

      if (!hasNextPage(html)) break;
      page++;
      await sleep(REQUEST_INTERVAL_MS);
    }

    console.log(`${entries.length} 件の日記が見つかりました。`);
    return entries;
  }

  // ── Individual entry ────────────────────────────────────────────────────

  async fetchDiaryEntry(entry: DiaryEntry): Promise<DiaryEntry> {
    console.log(`日記を取得中 id=${entry.id}: ${entry.title}`);
    const url = `${VIEW_DIARY_URL}?id=${entry.id}&owner_id=${entry.ownerId}`;
    const response = await sessionFetch(this.jar, url);
    const html = await response.text();
    return extractDiaryDetail(html, entry);
  }

  // ── Photos ──────────────────────────────────────────────────────────────

  async downloadPhoto(
    photoUrl: string,
    destDir: string,
    fetchFn: FetchFn = (u, o) => sessionFetch(this.jar, u, o)
  ): Promise<string | null> {
    try {
      const filename = path.basename(new URL(photoUrl).pathname) || "photo.jpg";
      const destPath = path.join(destDir, filename);
      if (fs.existsSync(destPath)) return filename;

      const response = await fetchFn(photoUrl, {});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(destPath, buffer);
      return filename;
    } catch (err) {
      console.warn(`写真のダウンロードに失敗しました: ${photoUrl}`, err);
      return null;
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private diaryDir(entryId: string): string {
    const dir = path.join(this.outputDir, "diaries", entryId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveEntry(entry: DiaryEntry): void {
    const dir = this.diaryDir(entry.id);

    if (entry.bodyHtml) {
      fs.writeFileSync(path.join(dir, "body.html"), entry.bodyHtml, "utf-8");
    }

    // Exclude the raw HTML blob from the JSON to keep it readable
    const { bodyHtml: _bodyHtml, ...meta } = entry;
    fs.writeFileSync(
      path.join(dir, "entry.json"),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );
  }

  // ── Orchestration ───────────────────────────────────────────────────────

  async run(email: string, password: string): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true });

    await this.login(email, password);
    const entries = await this.fetchDiaryList();

    const index: Omit<DiaryEntry, "bodyHtml">[] = [];

    for (const entry of entries) {
      let full: DiaryEntry;
      try {
        full = await this.fetchDiaryEntry(entry);
      } catch (err) {
        console.warn(`日記 ${entry.id} のスキップ:`, err);
        continue;
      }

      // Download photos
      if (full.photoUrls && full.photoUrls.length > 0) {
        const photoDir = this.diaryDir(full.id);
        const localPhotos: string[] = [];
        for (const photoUrl of full.photoUrls) {
          const fname = await this.downloadPhoto(photoUrl, photoDir);
          if (fname) localPhotos.push(fname);
          await sleep(REQUEST_INTERVAL_MS);
        }
        full.localPhotos = localPhotos;
      }

      this.saveEntry(full);
      const { bodyHtml: _bodyHtml, ...meta } = full;
      index.push(meta);
      await sleep(REQUEST_INTERVAL_MS);
    }

    fs.writeFileSync(
      path.join(this.outputDir, "index.json"),
      JSON.stringify(index, null, 2),
      "utf-8"
    );
    console.log(`バックアップ完了: ${index.length} 件を ${this.outputDir} に保存しました。`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("mixi-backup")
    .description("mixiの日記・写真・コメントをバックアップします。")
    .requiredOption("--email <email>", "mixiのメールアドレス")
    .requiredOption("--password <password>", "mixiのパスワード")
    .option("--output <dir>", "保存先ディレクトリ", "./backup")
    .parse(process.argv);

  const opts = program.opts<{ email: string; password: string; output: string }>();
  const backup = new MixiBackup(opts.output);
  await backup.run(opts.email, opts.password);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
