# mixi-backup

mixiの自分の日記を全てバックアップするTypeScriptツールです。  
ログインして日記一覧を取得し、各日記の本文・コメント・写真をローカルに保存します。

## 機能

- メールアドレスとパスワードでログイン（Node.js内蔵の`fetch`を使用）
- 全ページの日記一覧を自動取得（ページネーション対応）
- 各日記の本文・日時をHTML/JSONで保存
- 各日記に紐づくコメント（投稿者・本文・日時）を保存
- 各日記に添付された写真をダウンロード

## セットアップ

```bash
npm install
```

## 使い方

```bash
# ビルド
npm run build

# 実行
node dist/mixi_backup.js --email your@email.com --password yourpassword --output ./backup
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
npm test
```

## 注意事項

- **自分自身の日記のバックアップ目的のみで利用してください。**
- mixiの利用規約を遵守してご利用ください。
- ネットワーク負荷を抑えるため、リクエスト間に自動的に待機時間を設けています。
