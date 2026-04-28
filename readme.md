# mixi-backup

mixiの自分の日記を全てバックアップするPythonツールです。  
ログインして日記一覧を取得し、各日記の本文・コメント・写真をローカルに保存します。

## 機能

- メールアドレスとパスワードでログイン
- 全ページの日記一覧を自動取得（ページネーション対応）
- 各日記の本文・日時をHTML/JSONで保存
- 各日記に紐づくコメント（投稿者・本文・日時）を保存
- 各日記に添付された写真をダウンロード

## セットアップ

```bash
pip install -r requirements.txt
```

## 使い方

```bash
python mixi_backup.py --email your@email.com --password yourpassword --output ./backup
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `--email` | mixiのメールアドレス | 必須 |
| `--password` | mixiのパスワード | 必須 |
| `--output` | 保存先ディレクトリ | `./backup` |

## 保存形式

```
backup/
├── index.json              # 全日記のサマリー一覧
└── diaries/
    └── <diary_id>/
        ├── entry.json      # タイトル・日時・コメント・写真ファイル名
        ├── body.html       # 日記本文のHTML
        └── photo1.jpg      # ダウンロードした写真（あれば）
```

## テスト

```bash
pip install pytest
python -m pytest tests/ -v
```

## 注意事項

- **自分自身の日記のバックアップ目的のみで利用してください。**
- mixiの利用規約を遵守してご利用ください。
- ネットワーク負荷を抑えるため、リクエスト間に自動的に待機時間を設けています。
