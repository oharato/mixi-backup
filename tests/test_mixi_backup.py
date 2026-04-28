"""Unit tests for mixi_backup.py (no network calls)."""

import json
import os
import textwrap
import unittest
from unittest.mock import MagicMock, patch, PropertyMock

from bs4 import BeautifulSoup

from mixi_backup import MixiBackup, BASE_URL


# ---------------------------------------------------------------------------
# HTML fixture helpers
# ---------------------------------------------------------------------------

LOGIN_SUCCESS_HTML = textwrap.dedent(
    """\
    <html><body>
      <a href="/view_profile.pl?id=99999">マイプロフィール</a>
    </body></html>
    """
)

DIARY_LIST_PAGE_1 = textwrap.dedent(
    """\
    <html><body>
      <ul>
        <li><a href="/view_diary.pl?id=1001&amp;owner_id=99999">日記タイトル1</a><span class="date">2024-01-01</span></li>
        <li><a href="/view_diary.pl?id=1002&amp;owner_id=99999">日記タイトル2</a><span class="date">2024-01-02</span></li>
      </ul>
      <a href="/list_diary.pl?page=2">次のページ</a>
    </body></html>
    """
)

DIARY_LIST_PAGE_2 = textwrap.dedent(
    """\
    <html><body>
      <ul>
        <li><a href="/view_diary.pl?id=1003&amp;owner_id=99999">日記タイトル3</a><span class="date">2024-01-03</span></li>
      </ul>
    </body></html>
    """
)

DIARY_DETAIL_HTML = textwrap.dedent(
    """\
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
    </body></html>
    """
)


def _make_response(text: str, url: str = "https://mixi.jp/home.pl", status: int = 200):
    resp = MagicMock()
    resp.text = text
    resp.url = url
    resp.status_code = status
    resp.raise_for_status = MagicMock()
    resp.content = text.encode("utf-8")
    return resp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestLogin(unittest.TestCase):
    def setUp(self):
        self.backup = MixiBackup(output_dir="/tmp/mixi_test_backup")

    def test_login_success_extracts_owner_id(self):
        with patch.object(self.backup.session, "post") as mock_post:
            mock_post.return_value = _make_response(
                LOGIN_SUCCESS_HTML, url="https://mixi.jp/home.pl"
            )
            self.backup.login("test@example.com", "password")
        self.assertEqual(self.backup.owner_id, "99999")

    def test_login_failure_raises(self):
        with patch.object(self.backup.session, "post") as mock_post:
            mock_post.return_value = _make_response(
                "<html><body>ログインに失敗しました</body></html>",
                url="https://mixi.jp/login.pl",
            )
            with self.assertRaises(RuntimeError):
                self.backup.login("bad@example.com", "wrong")

    def test_extract_owner_id_from_url_query(self):
        resp = _make_response("", url="https://mixi.jp/home.pl?owner_id=12345")
        result = self.backup._extract_owner_id(resp)
        self.assertEqual(result, "12345")

    def test_extract_owner_id_from_profile_link(self):
        resp = _make_response(
            '<html><body><a href="/view_profile.pl?id=55555">プロフィール</a></body></html>',
            url="https://mixi.jp/home.pl",
        )
        result = self.backup._extract_owner_id(resp)
        self.assertEqual(result, "55555")


class TestDiaryList(unittest.TestCase):
    def setUp(self):
        self.backup = MixiBackup(output_dir="/tmp/mixi_test_backup")
        self.backup.owner_id = "99999"

    def test_parse_diary_list_page(self):
        soup = BeautifulSoup(DIARY_LIST_PAGE_1, "lxml")
        entries = self.backup._parse_diary_list_page(soup)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["id"], "1001")
        self.assertEqual(entries[1]["id"], "1002")
        self.assertEqual(entries[0]["owner_id"], "99999")

    def test_has_next_page_true(self):
        soup = BeautifulSoup(DIARY_LIST_PAGE_1, "lxml")
        self.assertTrue(self.backup._has_next_page(soup))

    def test_has_next_page_false(self):
        soup = BeautifulSoup(DIARY_LIST_PAGE_2, "lxml")
        self.assertFalse(self.backup._has_next_page(soup))

    def test_fetch_diary_list_paginates(self):
        responses = [
            _make_response(DIARY_LIST_PAGE_1),
            _make_response(DIARY_LIST_PAGE_2),
        ]
        with patch.object(self.backup.session, "get", side_effect=responses):
            with patch("mixi_backup.time.sleep"):
                entries = self.backup.fetch_diary_list()
        self.assertEqual(len(entries), 3)
        ids = [e["id"] for e in entries]
        self.assertIn("1001", ids)
        self.assertIn("1002", ids)
        self.assertIn("1003", ids)

    def test_fetch_diary_list_no_duplicates(self):
        # If the same diary link appears twice on a page it should appear once.
        html = textwrap.dedent(
            """\
            <html><body>
              <a href="/view_diary.pl?id=2001&owner_id=99999">dup</a>
              <a href="/view_diary.pl?id=2001&owner_id=99999">dup</a>
            </body></html>
            """
        )
        soup = BeautifulSoup(html, "lxml")
        entries = self.backup._parse_diary_list_page(soup)
        self.assertEqual(len(entries), 1)


class TestDiaryDetail(unittest.TestCase):
    def setUp(self):
        self.backup = MixiBackup(output_dir="/tmp/mixi_test_backup")
        self.backup.owner_id = "99999"

    def _soup(self, html: str) -> BeautifulSoup:
        return BeautifulSoup(html, "lxml")

    def test_extract_body(self):
        soup = self._soup(DIARY_DETAIL_HTML)
        html, text = self.backup._extract_body(soup)
        self.assertIn("テスト本文", html)
        self.assertIn("テスト本文", text)

    def test_extract_date(self):
        soup = self._soup(DIARY_DETAIL_HTML)
        date = self.backup._extract_date(soup)
        self.assertIn("2024", date)

    def test_extract_photo_urls(self):
        soup = self._soup(DIARY_DETAIL_HTML)
        urls = self.backup._extract_photo_urls(soup)
        self.assertIn("https://photo.mixi.jp/img/photo1.jpg", urls)

    def test_extract_comments(self):
        soup = self._soup(DIARY_DETAIL_HTML)
        comments = self.backup._extract_comments(soup)
        self.assertGreaterEqual(len(comments), 1)
        authors = [c["author"] for c in comments]
        self.assertIn("友達A", authors)
        bodies = [c["body"] for c in comments]
        self.assertTrue(any("コメント本文" in b for b in bodies))

    def test_extract_body_empty_when_no_element(self):
        soup = self._soup("<html><body></body></html>")
        html, text = self.backup._extract_body(soup)
        self.assertEqual(html, "")
        self.assertEqual(text, "")

    def test_fetch_diary_entry(self):
        entry = {"id": "1001", "owner_id": "99999", "title": "日記タイトル1", "url": "..."}
        with patch.object(
            self.backup.session, "get", return_value=_make_response(DIARY_DETAIL_HTML)
        ):
            result = self.backup.fetch_diary_entry(entry)
        self.assertEqual(result["id"], "1001")
        self.assertIn("テスト本文", result["body_text"])
        self.assertGreaterEqual(len(result["comments"]), 1)
        self.assertIn("https://photo.mixi.jp/img/photo1.jpg", result["photo_urls"])


class TestPhotoDownload(unittest.TestCase):
    def setUp(self):
        self.backup = MixiBackup(output_dir="/tmp/mixi_test_backup")

    def test_download_photo_saves_file(self):
        dest = "/tmp/mixi_test_photos"
        os.makedirs(dest, exist_ok=True)
        photo_bytes = b"\xff\xd8\xff\xe0test"
        resp = MagicMock()
        resp.content = photo_bytes
        resp.raise_for_status = MagicMock()
        with patch.object(self.backup.session, "get", return_value=resp):
            fname = self.backup.download_photo(
                "https://photo.mixi.jp/img/test.jpg", dest
            )
        self.assertEqual(fname, "test.jpg")
        saved = os.path.join(dest, "test.jpg")
        self.assertTrue(os.path.exists(saved))
        with open(saved, "rb") as f:
            self.assertEqual(f.read(), photo_bytes)

    def test_download_photo_returns_none_on_error(self):
        dest = "/tmp/mixi_test_photos"
        os.makedirs(dest, exist_ok=True)
        import requests as req_lib
        with patch.object(
            self.backup.session,
            "get",
            side_effect=req_lib.RequestException("network error"),
        ):
            result = self.backup.download_photo(
                "https://photo.mixi.jp/img/fail.jpg", dest
            )
        self.assertIsNone(result)

    def test_download_photo_skips_existing(self):
        dest = "/tmp/mixi_test_photos"
        os.makedirs(dest, exist_ok=True)
        existing = os.path.join(dest, "existing.jpg")
        with open(existing, "wb") as f:
            f.write(b"existing")
        with patch.object(self.backup.session, "get") as mock_get:
            fname = self.backup.download_photo(
                "https://photo.mixi.jp/img/existing.jpg", dest
            )
        mock_get.assert_not_called()
        self.assertEqual(fname, "existing.jpg")


class TestSaveEntry(unittest.TestCase):
    def setUp(self):
        self.backup = MixiBackup(output_dir="/tmp/mixi_test_save")

    def test_save_entry_creates_files(self):
        entry = {
            "id": "7001",
            "owner_id": "99999",
            "title": "テスト日記",
            "date": "2024-01-01",
            "body_html": "<div>本文</div>",
            "body_text": "本文",
            "photo_urls": [],
            "comments": [{"author": "A", "body": "コメント", "date": "2024-01-02"}],
        }
        self.backup.save_entry(entry)
        d = os.path.join(self.backup.output_dir, "diaries", "7001")
        self.assertTrue(os.path.exists(os.path.join(d, "body.html")))
        self.assertTrue(os.path.exists(os.path.join(d, "entry.json")))
        with open(os.path.join(d, "entry.json"), encoding="utf-8") as f:
            meta = json.load(f)
        self.assertNotIn("body_html", meta)
        self.assertEqual(meta["title"], "テスト日記")
        self.assertEqual(len(meta["comments"]), 1)


if __name__ == "__main__":
    unittest.main()
