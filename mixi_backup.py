"""mixi_backup.py - Back up your mixi diary entries, photos, and comments.

Usage:
    python mixi_backup.py --email you@example.com --password yourpass [--output ./backup]
"""

import argparse
import json
import logging
import os
import re
import time
from urllib.parse import urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

BASE_URL = "https://mixi.jp"
LOGIN_URL = f"{BASE_URL}/login.pl"
DIARY_LIST_URL = f"{BASE_URL}/list_diary.pl"
VIEW_DIARY_URL = f"{BASE_URL}/view_diary.pl"

REQUEST_INTERVAL = 1.5  # seconds between requests to be polite


class MixiBackup:
    """Downloads all diary entries, comments and photos from a mixi account."""

    def __init__(self, output_dir: str = "./backup") -> None:
        self.output_dir = output_dir
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            }
        )
        self.owner_id: str | None = None

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def login(self, email: str, password: str) -> None:
        """Log in to mixi and store the session cookies."""
        logger.info("Logging in as %s …", email)
        payload = {
            "next_url": "/home.pl",
            "email": email,
            "password": password,
        }
        response = self.session.post(LOGIN_URL, data=payload, allow_redirects=True)
        response.raise_for_status()

        if "home.pl" not in response.url and "mixi_id" not in response.url:
            raise RuntimeError(
                "Login failed — please check your e-mail and password."
            )

        self.owner_id = self._extract_owner_id(response)
        if not self.owner_id:
            raise RuntimeError("Could not determine your mixi owner ID after login.")
        logger.info("Logged in successfully (owner_id=%s).", self.owner_id)

    def _extract_owner_id(self, response: requests.Response) -> str | None:
        """Try to extract the owner_id from the post-login page."""
        # Check URL first (mixi sometimes redirects to /home.pl?...)
        parsed = urlparse(response.url)
        qs = parse_qs(parsed.query)
        if "owner_id" in qs:
            return qs["owner_id"][0]

        # Fall back to scraping the page
        soup = BeautifulSoup(response.text, "lxml")

        # Links like /view_profile.pl?id=12345
        profile_link = soup.find("a", href=re.compile(r"view_profile\.pl\?id=(\d+)"))
        if profile_link:
            m = re.search(r"id=(\d+)", profile_link["href"])
            if m:
                return m.group(1)

        # Hidden input on the page
        hidden = soup.find("input", {"name": "owner_id"})
        if hidden and hidden.get("value"):
            return hidden["value"]

        return None

    # ------------------------------------------------------------------
    # Diary listing
    # ------------------------------------------------------------------

    def fetch_diary_list(self) -> list[dict]:
        """Return a list of dicts with ``id``, ``owner_id``, ``title``, ``date``."""
        entries: list[dict] = []
        page = 1

        while True:
            logger.info("Fetching diary list page %d …", page)
            params = {"page": page, "owner_id": self.owner_id}
            response = self.session.get(DIARY_LIST_URL, params=params)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "lxml")

            new_entries = self._parse_diary_list_page(soup)
            if not new_entries:
                break
            entries.extend(new_entries)

            # Check whether a "next page" link exists
            if not self._has_next_page(soup):
                break
            page += 1
            time.sleep(REQUEST_INTERVAL)

        logger.info("Found %d diary entries.", len(entries))
        return entries

    def _parse_diary_list_page(self, soup: BeautifulSoup) -> list[dict]:
        entries = []
        # mixi diary list items are in <li> tags inside a <ul class="list-...">
        for link in soup.find_all("a", href=re.compile(r"view_diary\.pl")):
            href = link.get("href", "")
            m_id = re.search(r"id=(\d+)", href)
            m_owner = re.search(r"owner_id=(\d+)", href)
            if not m_id:
                continue
            entry = {
                "id": m_id.group(1),
                "owner_id": m_owner.group(1) if m_owner else self.owner_id,
                "title": link.get_text(strip=True),
                "url": urljoin(BASE_URL, href),
            }
            # Avoid duplicates
            if not any(e["id"] == entry["id"] for e in entries):
                entries.append(entry)
        return entries

    def _has_next_page(self, soup: BeautifulSoup) -> bool:
        next_link = soup.find("a", string=re.compile(r"次|next"))
        return next_link is not None

    # ------------------------------------------------------------------
    # Individual diary entry
    # ------------------------------------------------------------------

    def fetch_diary_entry(self, entry: dict) -> dict:
        """Fetch the full content (body, comments, photo URLs) for one entry."""
        logger.info("Fetching diary %s: %s", entry["id"], entry.get("title", ""))
        params = {"id": entry["id"], "owner_id": entry["owner_id"]}
        response = self.session.get(VIEW_DIARY_URL, params=params)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "lxml")

        body_html, body_text = self._extract_body(soup)
        date = self._extract_date(soup)
        photos = self._extract_photo_urls(soup)
        comments = self._extract_comments(soup)

        return {
            **entry,
            "date": date,
            "body_html": body_html,
            "body_text": body_text,
            "photo_urls": photos,
            "comments": comments,
        }

    def _extract_body(self, soup: BeautifulSoup) -> tuple[str, str]:
        """Return (raw_html, plain_text) of the diary body."""
        # mixi wraps diary body in a <div class="diaryBody"> or similar
        body_div = (
            soup.find("div", class_=re.compile(r"diaryBody|diary-body|contents"))
            or soup.find("div", id=re.compile(r"diaryBody|diary_body"))
        )
        if body_div:
            return str(body_div), body_div.get_text(separator="\n", strip=True)
        return "", ""

    def _extract_date(self, soup: BeautifulSoup) -> str:
        date_el = soup.find(
            ["span", "div", "time"],
            class_=re.compile(r"date|time|timestamp", re.IGNORECASE),
        )
        if date_el:
            return date_el.get_text(strip=True)
        return ""

    def _extract_photo_urls(self, soup: BeautifulSoup) -> list[str]:
        urls = []
        for img in soup.find_all("img", src=re.compile(r"photo|img|image", re.IGNORECASE)):
            src = img.get("src", "")
            if src and src.startswith("http"):
                urls.append(src)
        return list(dict.fromkeys(urls))  # deduplicate, preserve order

    def _extract_comments(self, soup: BeautifulSoup) -> list[dict]:
        comments = []
        comment_items = soup.find_all(
            ["div", "li"],
            class_=re.compile(r"comment|Comment", re.IGNORECASE),
        )
        for item in comment_items:
            author_el = item.find(
                ["span", "div", "a"],
                class_=re.compile(r"name|author|nick", re.IGNORECASE),
            )
            body_el = item.find(
                ["span", "div", "p"],
                class_=re.compile(r"body|text|content", re.IGNORECASE),
            )
            date_el = item.find(
                ["span", "div"],
                class_=re.compile(r"date|time", re.IGNORECASE),
            )
            comment = {
                "author": author_el.get_text(strip=True) if author_el else "",
                "body": body_el.get_text(separator="\n", strip=True) if body_el else "",
                "date": date_el.get_text(strip=True) if date_el else "",
            }
            if comment["body"] or comment["author"]:
                comments.append(comment)
        return comments

    # ------------------------------------------------------------------
    # Photo download
    # ------------------------------------------------------------------

    def download_photo(self, url: str, dest_dir: str) -> str | None:
        """Download a photo to *dest_dir* and return the local filename."""
        try:
            filename = os.path.basename(urlparse(url).path) or "photo.jpg"
            dest_path = os.path.join(dest_dir, filename)
            if os.path.exists(dest_path):
                return filename
            resp = self.session.get(url, timeout=30)
            resp.raise_for_status()
            with open(dest_path, "wb") as f:
                f.write(resp.content)
            return filename
        except requests.RequestException as exc:
            logger.warning("Failed to download %s: %s", url, exc)
            return None

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    def _diary_dir(self, entry_id: str) -> str:
        path = os.path.join(self.output_dir, "diaries", entry_id)
        os.makedirs(path, exist_ok=True)
        return path

    def save_entry(self, entry: dict) -> None:
        """Save the full entry data (JSON + HTML body) to disk."""
        d = self._diary_dir(entry["id"])

        # Save raw HTML body
        if entry.get("body_html"):
            with open(os.path.join(d, "body.html"), "w", encoding="utf-8") as f:
                f.write(entry["body_html"])

        # Save full metadata as JSON (exclude large html blob)
        meta = {k: v for k, v in entry.items() if k != "body_html"}
        with open(os.path.join(d, "entry.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

    # ------------------------------------------------------------------
    # Orchestration
    # ------------------------------------------------------------------

    def run(self, email: str, password: str) -> None:
        """Full backup: login → list → fetch each entry → download photos."""
        os.makedirs(self.output_dir, exist_ok=True)

        self.login(email, password)

        entries = self.fetch_diary_list()

        all_entries = []
        for entry in entries:
            try:
                full = self.fetch_diary_entry(entry)
            except requests.RequestException as exc:
                logger.warning("Skipping entry %s: %s", entry.get("id"), exc)
                continue

            # Download photos
            if full.get("photo_urls"):
                photo_dir = self._diary_dir(full["id"])
                local_photos = []
                for url in full["photo_urls"]:
                    fname = self.download_photo(url, photo_dir)
                    if fname:
                        local_photos.append(fname)
                    time.sleep(REQUEST_INTERVAL)
                full["local_photos"] = local_photos

            self.save_entry(full)
            all_entries.append({k: v for k, v in full.items() if k != "body_html"})
            time.sleep(REQUEST_INTERVAL)

        # Write summary index
        index_path = os.path.join(self.output_dir, "index.json")
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(all_entries, f, ensure_ascii=False, indent=2)
        logger.info("Backup complete. %d entries saved to %s", len(all_entries), self.output_dir)


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Back up your mixi diary entries, photos, and comments."
    )
    parser.add_argument("--email", required=True, help="Your mixi e-mail address")
    parser.add_argument("--password", required=True, help="Your mixi password")
    parser.add_argument(
        "--output",
        default="./backup",
        help="Directory to store the backup (default: ./backup)",
    )
    args = parser.parse_args()

    backup = MixiBackup(output_dir=args.output)
    backup.run(email=args.email, password=args.password)


if __name__ == "__main__":
    main()
