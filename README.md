# KLMS Plus — 課題分類・公式シラバス連携版

KLMS（Canvas LMS）のAccess Tokenで履修講義・時間割・課題を同期し、課題の期限状態と空き教室候補を確認するローカルWebアプリです。

## 追加された機能

### 課題の期限分類

課題は次の状態に自動分類されます。

- 期限超過済み
- 期限前1週間以内
- 期限前（8日以上）
- 期限未設定
- 完了済み

課題管理画面のフィルターでは、「期限前（すべて）」を含めて状態別に絞り込めます。ダッシュボードには「期限前1週間以内」の件数が表示されます。

### 空き教室候補の判定

空き教室画面で、キャンパス、曜日、時限、設備条件を指定できます。

判定には次のデータを使用します。

1. KLMS / Canvasから同期した時間割
2. 慶應公式シラバス詳細URLから取り込んだ曜日時限・キャンパス・教室
3. 教室番号付き公式時間割JSON
4. ユーザーが登録した教室設備情報

指定した曜日・時限に同じ教室の授業が見つかった場合は「使用予定あり」と表示します。それ以外は「空き候補」です。

「空き候補」は空室を保証するものではありません。臨時予約、休講・補講、教室変更、学内行事などはK-Supportや現地表示も確認してください。

## 起動方法

Node.js 18以降を用意し、このフォルダで次を実行します。

```bash
npm start
```

ブラウザで次を開きます。

```text
http://localhost:3000
```

`index.html`を直接開いた場合、画面の基本機能は使えますが、KLMS同期とシラバスURL取得は利用できません。

## KLMS同期

1. 左メニューの「設定」を開く
2. KLMS URLが `https://lms.keio.jp` であることを確認
3. Canvas Access Tokenを入力
4. 「トークンを確認」を押す
5. 「時間割・課題を同期」を押す

Keio IDのパスワードは入力しないでください。画面入力したAccess TokenはlocalStorageやファイルには保存しません。

## 公式シラバスURLの取り込み

1. 「空き教室」を開く
2. 「公式シラバス検索」を開く
3. 検索結果から授業の詳細ページを開く
4. `https://gslbs.keio.jp/pub-syllabus/detail?...` 形式のURLをコピー
5. アプリの入力欄へ1行ずつ貼り付ける
6. 「シラバスURLを取り込む」を押す

一度に50件まで取り込めます。取得対象は `gslbs.keio.jp` の公式詳細URLに限定しています。

公開シラバスから主に次を取得します。

- 授業名
- 年度・学期
- 曜日時限
- キャンパス
- 登録番号
- 教室番号（ページに表示される場合）

公開ページに教室番号がない科目は、キャンパスと曜日時限だけ登録します。ブラウザでログインしていても、ローカルサーバーにはkeio.jpのログインセッションが共有されないため、認証後だけ表示される教室情報を自動取得できない場合があります。

## 教室番号付きJSONの形式

認証後の時間割データなどをJSONにできる場合は、空き教室画面から取り込めます。

```json
[
  {
    "title": "講義名",
    "day": "月",
    "period": "2",
    "campus": "日吉",
    "room": "J11",
    "url": "https://gslbs.keio.jp/pub-syllabus/detail?..."
  }
]
```

`days`、`periods`を配列で指定する形式にも対応しています。

## Canvas同期対象

- `GET /api/v1/users/self/profile`
- `GET /api/v1/courses`
- `GET /api/v1/courses/:course_id/assignments`
- `GET /api/v1/planner/items`
- `GET /api/v1/courses/:course_id/todo`
- `GET /api/v1/calendar_events`
- `GET /api/v1/courses/:course_id/calendar_events/timetable`

## セキュリティ上の注意

- Keio IDのパスワードを保存・送信しないでください。
- Access TokenをGit、メール、提出物、スクリーンショットに含めないでください。
- 自分に閲覧権限がある情報だけを取得してください。
- 大学システムへの大量アクセスは避けてください。

## Render三層構造版

この版はRender PostgreSQLへ課題・時間割・教室情報を保存できます。詳細は `RENDER_DEPLOY_GUIDE.md` を参照してください。

- Frontend: `index.html`, `styles.css`, `app.js`
- Backend: `server.js`
- Database: Render PostgreSQL (`app_states`)
- Health check: `/api/health`
