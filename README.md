# dsh-ssh-workspace

[pi-ssh-remote](https://github.com/99percentpeople/pi-extensions) と同じ考え方で、
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) のセッションの作業場所を SSH 先に切り替えるプラグインです。
会話・認証情報・セッションの記録は手元に残したまま、作業用のツールだけを SSH 先で実行します。

## 使い方

```text
/ssh-connect <[user@]host[:port][:path]>   作業場所を SSH 先へ（接続中なら別ホストへ直接切り替え）
/ssh-cd <path>                             SSH 先のフォルダを移動
/ssh-status                                今の作業場所を表示
/ssh-exit                                  手元に戻る
```

`~/.ssh/config` の別名がそのまま使えます（例: `/ssh-connect macmini:~/project`）。
モデルにも同じ4つが `ssh_connect` / `ssh_cd` / `ssh_status` / `ssh_exit` ツールとして渡ります。
認証は鍵か ssh-agent だけです（パスワード入力はしません）。

## SSH 先で動くもの

接続中のセッションでは、次のツールが SSH 先で動きます。結果は DSH の各ツールと同じ形で返るので、表示もそのままです。

| ツール | SSH 先での動き |
| --- | --- |
| `bash` | ログインシェル（`bash -lc`）で実行。DSH の bash job として登録するので、10秒で戻る動き・`run_in_background`・`job_output` / `job_kill`・dsh-monitor の30分ごとの報告・終了の知らせがそのまま使えます |
| `read` / `write` / `edit` | ファイルを読み書き。`write` は一時ファイル経由で置き換え |
| `glob` / `grep` | `rg` があれば使い、無ければ `find` / `grep` で代替 |
| `read_image` | 画像を手元に一時コピーして、DSH 標準の処理で読み込み |
| `working_directory` | SSH 先の作業フォルダを表示・変更 |

それ以外（Web検索、画像生成、monitor_watch_path など）は手元で動きます。
接続中は、モデルへの指示に「SSH 先の作業フォルダ」を伝える項目を足します（手元の作業フォルダの表示は残ります）。

## 仕組み

- OpenSSH の接続共有（ControlMaster、`~/.dsh/ssh-workspace/cm/`、10分保持）で、2回目以降の操作を速くしています。
- 接続先はセッションごとに `~/.dsh/ssh-workspace/sessions/` に保存し、セッションを再開すると SSH 先も戻ります。
- DSH の `tools/execute` に割り込んで、接続中のセッションの上記ツールだけを SSH 先の実装に差し替えます。

## 制約

- SSH 先は Unix（Linux / macOS）だけです。
- DSH のサンドボックス（ファイル操作の制限）と、読む前の編集を防ぐ確認は、SSH 先には掛かりません（pi-ssh-remote と同じ）。
- `bash` の `sandbox_permissions` は SSH 先では使えません。

## 導入

```sh
dsh plugin --profile web add "file:$PWD"
```

## テスト

```sh
node scripts/link-dsh.mjs
npm test
```

## ライセンス

MIT
