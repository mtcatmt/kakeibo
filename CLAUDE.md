# 家計簿（複式簿記・PWA）の開発メモ

iPhoneのホーム画面に追加して使う、複式簿記の家計簿とカレンダー。ビルドの手順はなく、ファイルをそのまま GitHub Pages で配る。データは端末の IndexedDB にだけ保存し、サーバーは使わない。使い方とデータの形は `README.md`、カレンダーの要件と決まったことは `docs/calendar-requirements.md` にある。

## ファイル

- `ledger.js`：帳簿の計算（画面に依存しない）。`SCHEMA` と `migrate()` はデータの版の管理なので、変えるときは版を上げ、古いデータからの移行を書く。
- `calendar.js`：カレンダーの計算（予定名の時間の読み取り・並び順・祝日・営業日・`.ics`・`state.calendar` の用意）。`ledger.js` の `SCHEMA` は使わず、`ensureCalendar()` を `L.migrate()` のあとで呼ぶ。
- `app.js`：画面すべて（入力・履歴・カレンダー・グラフ・設定）。`VIEWS` の関数が HTML の文字列を返し、`render()` で描く。ボタンは `data-act` と `ACTIONS`（カレンダーは `CAL_ACTIONS`）で動かす。
- `charts.js`：グラフ（SVG）。`style.css`：見た目（色は `:root` の変数。ダークモードも同じ変数で切り替える）。
- `sw.js`：オフライン用の Service Worker。`ASSETS` に配るファイルの一覧。
- `tests/*.test.mjs`：`ledger.js`・`calendar.js` のテスト。

## 変更するときの決まり

- 画面の動きを変えたら、`app.js` の `APP_VERSION` と、`sw.js` の `CACHE`（`kakeibo-vN`）の番号を上げる。上げないと、iPhoneに保存された古いファイルが使われ続ける。新しいファイルを足したら `sw.js` の `ASSETS` にも足す。
- テスト：`node --test tests/*.test.mjs`（`node --test tests/` は Node 22 では動かない）。計算の部分（`ledger.js`・`calendar.js`）を変えたらテストも足す。
- 画面の確認：`python3 -m http.server` で開き、URLの末尾に `?demo` を付けると仮のデータで見られる（保存はされない）。iPhoneの幅（390px）で崩れないか見る。
- 画面の文言・コードのコメント・コミットのメッセージ・README は日本語。文言は短い文で、です・ます調ではなく、今の画面に合わせる。
- 金額は1円単位の整数。支出は費用の行の合計（立替を除いた自分の分）で数える。
- 予定と仕訳のつながりは、仕訳の `eventId` だけに持つ。予定を消すときは `C.removeEvents()` でつながりも外す。
- `README.md` の該当する節も直す。

## 公開

`main` に push すると、1分ほどで GitHub Pages に反映される。iPhoneでは、アプリを開くと下に「再読み込み」が出るので押す（設定画面のいちばん下の版で確かめられる）。
