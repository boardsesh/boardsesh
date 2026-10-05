# Simplified Chinese translation glossary

Fixed terminology for Simplified Chinese (`zh-Hans`) translations. **Follow this for every Chinese string you add or edit.** An agent will not reliably know the right Chinese climbing term, so it is written down here.

Catalogs live in `packages/shared/i18n/locales/zh-Hans/`. The English source is `en-US/`.

> **Authority: none yet.** Every term below is a first draft written by an agent, not confirmed by a native-speaking climber. Until a reviewer is named here, treat the table as a consistency rule (use the same word everywhere), not as proof the word is right. When a reviewer corrects a term, change it here first, then in the catalogs.

## Scope: the app only

`zh-Hans` is an app-only locale (`APP_ONLY_LOCALES` in `packages/shared/i18n/src/config.ts`). It ships the twelve `MOBILE_NAMESPACES` and nothing else. There is no `/zh-Hans` page on www, and the web-only namespaces (`marketing`, `admin`, `gyms`, `kiosk`) must not be added to the `zh-Hans` folder: `catalog-completeness.test.ts` fails if they appear.

Traditional Chinese (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`) is not translated. Those devices get English, not Simplified.

## Address and tone

| Rule             | Use                                                         | Not                         |
| ---------------- | ----------------------------------------------------------- | --------------------------- |
| Address the user | 你                                                          | 您                          |
| Third person     | TA (profile of another climber)                             | 他/她                       |
| Tone             | Short, plain, spoken. "再试一次。"                          | Formal "请您稍后重新尝试"   |
| Error messages   | Say what happened, then what to do: "没保存上，再试一次。"  | "操作失败" with no next step |

## Never 发送 for a climbing send

English climbing borrowed "to send" for completing a climb. 发送 means transmitting data. Use it only for emails, reports and exports.

| English                    | Chinese                  | Not                |
| -------------------------- | ------------------------ | ------------------ |
| send (noun, verb, status)  | 完攀                     | 发送               |
| Sent (status chip)         | 已完攀                   | 已发送             |
| {{count}} sends            | 完攀 {{count}} 条 / {{count}} 次完攀 | {{count}} 发送 |
| hardest send               | 最难完攀                 |                    |
| ascent                     | 完攀                     | 攀登               |
| first ascent               | 首攀                     |                    |
| light a climb on the board | 点亮                     | 发送到训练板       |
| turn the board off         | 熄灭                     |                    |

## Climbing terms

| English                        | Chinese        | Note                                                    |
| ------------------------------ | -------------- | ------------------------------------------------------- |
| climb / problem                | 线路           | counter word 条: 3 条线路                               |
| boulder (climb type)           | 抱石           |                                                         |
| route (multi-frame climb type) | 路线           | only where the UI contrasts it with 抱石                |
| attempt / try                  | 尝试           | counter word 次                                         |
| flash                          | Flash          | kept in English, as climbers say it; status 已 Flash    |
| redpoint                       | 红点           |                                                         |
| project (noun)                 | 项目           | "to project" is 磕线                                    |
| repeat                         | 重复完攀       |                                                         |
| grade                          | 难度           | "V grade" is V 级, "French" is 法式                     |
| soft / stiff (grade)           | 软 / 硬        |                                                         |
| quality / stars                | 质量 / 星级    |                                                         |
| hold                           | 岩点           | counter word 个                                         |
| start hold                     | 起步点         |                                                         |
| hand hold ("Mid", "Hand")      | 手点           |                                                         |
| finish hold                    | 结束点         |                                                         |
| foot hold                      | 脚点           |                                                         |
| hold set                       | 岩点套组       | short form 套组                                         |
| matching (hands on one hold)   | 并手           | 允许并手 / 禁止并手                                     |
| campus                         | Campus         | kept in English, gloss it once: Campus（不用脚）        |
| footless                       | 无脚           |                                                         |
| kickboard                      | 脚踏板         |                                                         |
| angle                          | 角度           |                                                         |
| mirror / mirrored              | 镜像           |                                                         |
| benchmark                      | 基准线路       |                                                         |
| classic                        | 经典           |                                                         |
| setter                         | 定线员         | "set by X" is 定线：X, "to set" is 定线                 |
| climber                        | 岩友           | friendly default; 完攀者 for "ascensionist"             |
| crew                           | 伙伴 / 伙伴们  |                                                         |
| gym                            | 岩馆           |                                                         |
| wall                           | 墙 / 墙面      |                                                         |
| spray wall                     | 自由墙         | open question, see below                                |
| wall reset (spray wall)        | 重新布点       |                                                         |
| session                        | 训练           | counter word 场 for a live one, 次 for a past one        |
| workout (generated set)        | 训练计划       |                                                         |
| warm-up                        | 热身           |                                                         |
| logbook                        | 攀爬记录       |                                                         |
| tick / log (verb)              | 记录           |                                                         |
| queue                          | 队列           |                                                         |
| playlist                       | 线路单         |                                                         |
| circuit (Aurora's playlists)   | 线路集         | kept apart from 线路单 on purpose                       |
| draft                          | 草稿           |                                                         |
| remix / fork a climb           | 改编           |                                                         |
| feed                           | 动态           |                                                         |
| follow / follower / following  | 关注 / 粉丝 / 关注 |                                                     |
| like                           | 赞             |                                                         |
| proposal (community)           | 提议           |                                                         |
| report (a climb)               | 举报           |                                                         |
| moderation                     | 管理           |                                                         |
| leaderboard                    | 排行榜         |                                                         |
| heatmap                        | 热力图         |                                                         |
| offline / offline mode         | 离线 / 离线模式 |                                                        |
| sync                           | 同步           |                                                         |
| board (the device)             | 训练板         | counter word 块                                         |
| layout / size                  | 布局 / 尺寸    |                                                         |
| controller                     | 控制器         |                                                         |
| Bluetooth                      | 蓝牙           |                                                         |
| sign in / sign out             | 登录 / 退出登录 |                                                        |
| account                        | 账号           | not 帐号, not 账户                                      |
| settings                       | 设置           |                                                         |

## Keep these in English (do not translate)

| What                    | Examples                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Brand and product names | Boardsesh, Kilter, Kilter Board, Tension, Tension Board, MoonBoard, Aurora, Woods Board, Decoy, Grasshopper, Touchstone, So iLL |
| Other services          | Apple, Google, Strava, Garmin, Discord, GitHub, Instagram, TikTok, App Store               |
| Climbing loanwords      | beta, Flash, Campus                                                                        |
| Technical terms         | LED, ESP32, API, JSON, CSV, URL, Wi-Fi, PR, QA, Kiosk                                       |
| Look names              | Aura                                                                                       |
| `aurora.card.boardSuffix` | stays `Board`: it renders as `{boardName} Board`                                         |
| Emails sent to a board maker | `aurora.kilterEmail.*` and `aurora.moonboard.email.*` in `settings.json` stay in English, because the reader is the manufacturer's support desk |

Describe compatibility, never affiliation: 兼容 Kilter, not "Kilter 官方应用".

## Typography

| Rule                                   | Example                              |
| -------------------------------------- | ------------------------------------ |
| Full-width punctuation in Chinese text | ，。！？：（）“ ”                    |
| A space between Chinese and Latin text or digits | 完攀 3 条, 关联 Kilter 账号 |
| A space around a `{{placeholder}}` that renders a name or a number | 由 {{name}} 点亮 |
| No space before a unit sign            | 40°, 50%                             |
| Ellipsis for progress                  | 加载中…                              |
| Separators copied from English         | `·`, `→`, `/` stay as they are       |

## Plurals

Chinese has one plural category, `other`. i18next reads the `_other` key for every count and never reads `_one`. Key parity still requires `_one` to exist. Give it the same text as `_other`, unless the English `_one` hardcodes the number or drops a placeholder: placeholder parity then forces `_one` to differ ("1 条完攀正在路上" beside "{{count}} 条完攀正在路上").

Because `_other` is the string a climber with exactly one item reads, write it number-neutral: no 它们, 这些 or 他们. "记录已保存，但没有送达我们这里。", not "你记录了它们…". `catalog-completeness.test.ts` fails on those pronouns in a `_other` string.

## Rules that are not about words

- Translate values only. Keep every JSON key, every `{{placeholder}}` (including format hints such as `{{count, number}}`) and every tag (`<strong>`) exactly as in `en-US`.
- Keep the key order of the English file, so a later diff shows only the strings that changed.
- A fragment that the app joins to another string (`metadata.join.gradeOn`, `mobile.logbook.lifetimeSessions`) carries its own punctuation in Chinese. Read the neighbouring keys before changing one.

## Open questions for the reviewer

| Question                                              | Current choice | Alternatives            |
| ----------------------------------------------------- | -------------- | ----------------------- |
| Everyday word for a training board                    | 训练板         | 板, 岩板, Board         |
| Spray wall                                            | 自由墙         | 喷墙, Spray Wall        |
| Session                                               | 训练           | 攀爬, 局                |
| Playlist                                              | 线路单         | 线路列表, 歌单-style 线单 |
| Climber (friendly)                                    | 岩友           | 攀岩者                  |
| Crew                                                  | 伙伴           | 搭子, 小队              |
| Keep Flash in English, or use 一次完攀 / 闪           | Flash          |                         |
| Hand hold                                             | 手点           | 中间点                  |
| Finish hold                                           | 结束点         | 顶点, 终点              |
