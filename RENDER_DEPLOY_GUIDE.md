# KLMS Plus を Render に三層構造でデプロイする手順

## 完成条件

次の4点をすべて確認できたら完成です。

1. Render の公開URLで画面が開く
2. `/api/health` が `ok: true, database: true` を返す
3. 課題・時間割を PostgreSQL に保存できる
4. DBから再読み込みして、保存した内容が復元される

## 三層構造

- フロントエンド: `index.html`, `styles.css`, `app.js`
- バックエンド: `server.js`
- データベース: Render PostgreSQL の `app_states` テーブル

## Part 0: ZIPをWSLへ展開

WindowsのダウンロードフォルダにZIPがある想定です。

```bash
sudo apt update
sudo apt install -y unzip
mkdir -p ~/webpro/klms-plus-app
cd ~/webpro/klms-plus-app
unzip /mnt/c/Users/＜Windowsユーザー名＞/Downloads/klms_plus_app_render_3tier.zip
```

ZIPの中にフォルダが1つ入っている場合は、その中へ移動してください。

```bash
cd klms_plus_app_render_3tier
```

確認:

```bash
ls
```

`package.json`, `server.js`, `db.js`, `index.html`, `app.js` が表示されればOKです。

## Part 1: ローカルで起動確認

```bash
npm install
npm start
```

ブラウザで開きます。

```text
http://localhost:3000
```

この時点では `DATABASE_URL` がないため、DB接続は失敗表示でも正常です。

停止:

```text
Ctrl + C
```

## Part 2: GitHubへアップロード

まだGit管理していない場合:

```bash
git init
git branch -M main
git add .
git commit -m "Add KLMS Plus three-tier app"
gh repo create klms-plus-app --public --source=. --remote=origin --push
```

すでにリポジトリがある場合:

```bash
git add .
git commit -m "Add PostgreSQL persistence"
git push
```

`.env` と `node_modules` がGitHubに入っていないことを確認してください。

## Part 3: Render PostgreSQLを作成

1. RenderへGitHubでログイン
2. `New` → `Postgres`
3. Name: `klms-plus-db`
4. Region: 後で作るWeb Serviceと同じ地域
5. Instance Type: 授業用ならFreeが表示される場合はFree
6. `Create Database`
7. 状態が `Available` になるまで待つ
8. `Connect` から `Internal Database URL` をコピー

## Part 4: Render Web Serviceを作成

1. Renderで `New` → `Web Service`
2. GitHubの `klms-plus-app` を選択
3. 次の内容を設定

```text
Language: Node
Build Command: npm ci && npm run db:init
Start Command: npm start
Health Check Path: /api/health
```

環境変数:

```text
DATABASE_URL = Render PostgreSQLのInternal Database URL
KLMS_BASE_URL = https://lms.keio.jp
KLMS_SYNC_DAYS_PAST = 120
KLMS_SYNC_DAYS_FUTURE = 365
```

設定しないもの:

```text
PORT
CANVAS_ACCESS_TOKEN
```

`PORT`はRenderが設定します。Canvas Access Tokenは各利用者が画面上で入力します。

Web ServiceとPostgreSQLは同じRegionにしてください。

## Part 5: デプロイ

`Deploy Web Service` を押します。

ログで次を確認します。

```text
Database schema is ready: app_states
KLMS Plus is running on 0.0.0.0:...
```

公開URLが発行されたら開きます。

```text
https://＜サービス名＞.onrender.com
```

## Part 6: DB接続確認

公開URLの末尾に `/api/health` を付けます。

```text
https://＜サービス名＞.onrender.com/api/health
```

成功例:

```json
{
  "ok": true,
  "database": true,
  "checkedAt": "..."
}
```

アプリ内では次の順に操作します。

```text
設定
→ PostgreSQL接続を確認
→ 接続成功を確認
```

## Part 7: DB保存の動作確認

1. 課題管理で新しい課題を追加
2. 設定画面へ移動
3. `今すぐDBへ保存` を押す
4. `DBから再読み込み` を押す
5. 課題が残っていることを確認

より強い確認方法:

1. ブラウザの開発者ツールを開く
2. Application → Local Storage
3. `klms-plus-state-v2` だけ削除する
4. `klms-plus-client-id-v1` は残す
5. ページを再読み込みする
6. DBに保存した課題が復元されれば成功

## Part 8: KLMS同期

```text
設定
→ Canvas Access Tokenを入力
→ トークンを確認
→ 時間割・課題を同期
→ 今すぐDBへ保存
```

Canvas Access TokenをRenderの環境変数へ共通設定しないでください。

## Part 9: 変更を反映する方法

コードを変更したら:

```bash
git add .
git commit -m "Update KLMS Plus"
git push
```

GitHub連携したRender Web Serviceは、対象ブランチへのpush後に再デプロイされます。

## よくあるエラー

### `/api/health` が503

`DATABASE_URL` が未設定です。Render Web ServiceのEnvironmentを確認してください。

### `getaddrinfo ENOTFOUND`

DATABASE_URLが途中で切れている、またはExternal/Internal URLを誤って編集しています。URLを丸ごとコピーし直してください。

### `password authentication failed`

DBのURLが古い可能性があります。Render PostgreSQLのConnect画面から再コピーしてください。

### BuildでDB接続失敗

- PostgreSQLがAvailableか確認
- Web ServiceとDBのRegionが同じか確認
- `DATABASE_URL`にInternal Database URLを設定
- Manual Deploy → Deploy latest commit

### アプリは開くがDB保存できない

`/api/health`を先に確認し、Render LogsでPostgreSQLエラーを確認してください。

## 提出時に見せるもの

1. Render公開URL
2. `/api/health` の成功JSON
3. 課題追加画面
4. PostgreSQL接続成功表示
5. DBへ保存後、DBから再読み込みした画面
6. 三層構造図

```text
ブラウザ
  └─ index.html / app.js / styles.css
          ↓ HTTP / JSON
Render Web Service
  └─ server.js
          ↓ SQL
Render PostgreSQL
  └─ app_states
```
