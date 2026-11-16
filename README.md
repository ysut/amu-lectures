# 産婦人科 練習問題サイト

講義の練習問題を学生が自習するための Web サイトです。GitHub Pages で公開します。

- 問題は **Markdown で書くだけ**。`- [x]` が正解の選択肢です（→ [questions/README.md](questions/README.md)）
- 単一選択・複数選択（「2つ選べ」）・記述式（一問一答カード）に対応
- 正解・不正解の記録は各自のブラウザに保存し、「間違えた問題だけ復習」ができます
- スマートフォン対応、ダークモード対応
- サイト内の **問題エディタ** でプレビューしながら作問し、そのまま GitHub に追加できます
- 書き方に誤りがあると自動でチェックされ、**エラーのある状態では公開されません**
- （任意）大学の Microsoft 365 アカウント（Microsoft Entra ID）でのサインイン

## 問題を追加・編集する

→ **[questions/README.md](questions/README.md)** を参照してください。

```markdown
# 子宮頸癌

## 子宮頸癌の組織型で最も多いのはどれか。

- [ ] 腺癌
- [x] 扁平上皮癌
- [ ] 小細胞癌

### 解説
子宮頸癌の約 7 割は扁平上皮癌である。
```

## 初回セットアップ

1. GitHub でリポジトリを作成し、このフォルダを push する
   - 無料プランで GitHub Pages を使う場合、リポジトリは **Public** にする必要があります。
     Public の場合、`questions/` の問題ファイルは誰でも閲覧できます。
   - リポジトリを Private のまま Pages を使うには GitHub Pro 以上が必要です
     （教員は GitHub Education で Pro を無償で利用できる場合があります）。
     その場合でも、**公開されたサイト自体は誰でもアクセスできます**（下の「認証」を参照）。
2. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
3. **Actions** タブでワークフローが緑になれば、`https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます
4. `site.config.json` の `title`（サイト名）と `description`（説明）を必要に応じて編集する
5. ほかの先生にも問題を追加してもらう場合は、**Settings → Collaborators** で招待する

`site.config.json` の `repository` は空欄のままで構いません（GitHub Actions 上で自動的に設定され、
エディタの「GitHub に追加」ボタンや、各講義の「GitHub で編集」リンクに使われます）。

## 認証（Microsoft Entra ID でのサインイン）

### 先に知っておくこと：GitHub Pages の制約

GitHub Pages は静的なファイルを配信するだけなので、**サーバー側でアクセスを制限することはできません**。
このサイトの認証は「ブラウザでサインインしないと画面を表示しない」方式です。

- 学外の人がサイトを開いても、サインイン画面しか表示されません
- ただし、問題データ（`data/questions.json`）の URL を知っていれば直接取得できます。
  リポジトリが Public なら問題ファイルそのものも閲覧できます

「学外の人に気軽に見られないようにする」目的には十分ですが、厳密に秘匿したい内容には向きません
（その場合は後述の「厳密にアクセス制限したい場合」を参照）。

### 設定手順

1. [Microsoft Entra 管理センター](https://entra.microsoft.com/) → **アプリの登録** → **新規登録**
   （大学の設定によっては、情報センター等に登録を依頼する必要があります）
   - 名前：任意（例：産婦人科 練習問題）
   - サポートされているアカウントの種類：**この組織ディレクトリのみ（シングルテナント）**
   - リダイレクト URI：プラットフォームに **シングルページ アプリケーション (SPA)** を選び、
     `https://<ユーザー名>.github.io/<リポジトリ名>/` を入力（**末尾の `/` まで正確に**）
   - ローカルで確認する場合は、`http://localhost:8080/` も SPA のリダイレクト URI に追加します
2. 登録したアプリの「概要」から **アプリケーション (クライアント) ID** と **ディレクトリ (テナント) ID** を控える
3. `site.config.json` を次のように編集して push する

   ```json
   "auth": {
     "enabled": true,
     "clientId": "アプリケーション (クライアント) ID",
     "tenantId": "ディレクトリ (テナント) ID",
     "allowedDomains": []
   }
   ```

   - クライアント ID とテナント ID は秘密情報ではないので、リポジトリに書いて問題ありません
   - シングルテナントで登録していれば、その大学のアカウントしかサインインできないため、
     `allowedDomains` は通常空のままで構いません。メールアドレスのドメインでさらに絞りたい場合は
     `["example.ac.jp"]` のように指定します
4. 初回サインイン時に「管理者の承認が必要」と表示された場合は、テナントの管理者に
   このアプリへの同意（admin consent）を依頼してください

### 厳密にアクセス制限したい場合

サーバー側で認証をかけたい場合は、同じリポジトリのまま配信先を **Azure Static Web Apps** に変更する方法があります。
ビルド結果（`dist/`）はそのまま配信でき、Entra ID 認証をサーバー側で強制できます。
ただし、特定の大学のアカウントだけに限定するには独自の認証設定が必要で、これは **有料の Standard プラン**
で利用できる機能です（料金は Azure の最新情報を確認してください）。必要になったら移行を検討してください。

## ローカルで確認する（Docker）

```sh
docker compose up        # http://localhost:8080/ でプレビュー（ファイルを保存すると自動で再ビルド）
docker compose run --rm dev sh -c "npm ci && npm test"   # テスト
```

ローカルのプレビューでは、問題ファイルのエラーや注意がトップページに表示されます。

## 構成

```
questions/                      問題（Markdown）← 普段さわるのはここだけ
site.config.json                サイト名・認証の設定
src/                            サイト本体（HTML / CSS / JavaScript）
  parser.js                     問題ファイルの読み取り（ビルドとエディタで共通）
scripts/build.mjs               questions/ を検証して dist/ を生成
scripts/dev.mjs                 ローカル用プレビューサーバー
tests/                          テスト
.github/workflows/deploy.yml    GitHub Pages への自動デプロイ
```

main ブランチに push すると、GitHub Actions が `node:24-bookworm-slim` コンテナ内で
テスト → ビルド（問題ファイルの検証）→ GitHub Pages へのデプロイを行います。
Pull Request では検証だけを行い、デプロイはしません。
