# Simplified Chinese translation glossary

Terminology for Simplified Chinese (`zh-Hans`) text, aimed at mainland board climbers. **Follow this for every Chinese string you add or edit.** An agent will not reliably know the word a Chinese climber uses at the wall, so the choices are written down here.

Today this covers the store listing only: `fastlane/metadata/zh-Hans/` (App Store) and `fastlane/metadata/android/zh-CN/` (Play). The app catalogs are not translated yet, so the app a Chinese reader installs is in English. Both descriptions say so in their second paragraph (`App 界面目前为英文，中文版正在翻译中。`); keep that line until the catalogs ship. The English source is the matching `en-US` folder.

> **Authority: none yet.** Every term below is a proposal written by an agent. No native-speaking climber has read it. Until one has, treat the "Open questions" section as blocking, and do not ship Chinese text that depends on an unanswered question. When a reviewer settles a term, record their name here the way the German, French and Spanish glossaries do.

## Script and region

- **Simplified Chinese, mainland usage.** `线路`, not Taiwan's `路線` / `路线`. Traditional Chinese devices are out of scope.
- Store folder names differ per store and are both correct: `zh-Hans` for App Store Connect, `zh-CN` for Play.

## Address: **你** throughout

Informal **你**, never **您**. Same voice as the German _du_ and the Spanish _tú_.

## Punctuation and spacing

- Full-width Chinese punctuation in running text: `，` `。` `：` `；` `（）` `、`. Quotes are `“ ”`.
- The enumeration comma `、` separates list items (`Kilter、Tension 和 MoonBoard`).
- One half-width space between Chinese and a Latin word or number (`兼容 Woods`, `5,000 多条线路`). No space next to full-width punctuation.
- Section headings in listing text use `【 】`, which is how Chinese store listings mark what English does with capitals.
- `keywords.txt` is the exception: half-width commas, no spaces. App Store Connect splits on the half-width comma.
- **UI names are written the way the app shows them, which today is English**, followed by a Chinese gloss in full-width brackets: `Progress（进度）页`, `Climbs（线路）页`, `Rest timer（休息计时器）`. A multi-word label keeps its quotes: `“Fixed window”（固定间隔）`. Copy the label from the `en-US` catalog, not from the English release notes, which sometimes paraphrase it. Once the app catalogs are translated, switch to the Chinese name alone in `“ ”`.

## Never **发送** for a climbing send

English climbing borrowed "to send" for getting up a climb. **发送** means transmitting a message. A completed climb is **完攀**.

| English                         | Wrong          | Right                 |
| ------------------------------- | -------------- | --------------------- |
| a send, sends                   | 发送           | 完攀                  |
| sent (status)                   | 已发送         | 已完攀                |
| hardest send                    | 最难的发送     | 最难的一次完攀        |
| send a climb to the board (LED) | 发送到板上     | 点亮（到墙上）        |

Putting a climb on the wall is always **点亮**, including where English says "push to the wall".

## Core terms

| English                  | Chinese                         | Notes                                                                 |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------- |
| bouldering               | 抱石                            |                                                                       |
| board (the device)       | 训练板; 板 after first mention  | Open question 1                                                       |
| wall (what lights up)    | 墙                              | `看着墙亮起来`, `点亮到墙上`                                           |
| climb, problem           | 线路; 线 in short forms         | `换线`, `定线`                                                        |
| hold                     | 岩点                            |                                                                       |
| grade                    | 难度                            | Boardsesh grade is `Boardsesh 难度`                                   |
| angle                    | 角度                            |                                                                       |
| send                     | 完攀                            | See above                                                             |
| flash                    | Flash                           | Kept in English. Open question 4                                      |
| attempt, burn            | 尝试                            |                                                                       |
| to set, setter           | 定线, 定线员                    |                                                                       |
| remix (a climb)          | 改编                            |                                                                       |
| mirror (a climb)         | 镜像                            |                                                                       |
| match (hold rule)        | 并手                            | Open question 7                                                       |
| feet rules               | 脚点规则                        |                                                                       |
| gym                      | 岩馆                            |                                                                       |
| crew                     | 岩友                            | Open question 3                                                       |
| climber (search results) | 攀岩者                          |                                                                       |
| session                  | 训练 (`开一场训练`)             | Open question 2                                                       |
| workout                  | 训练计划                        | Volume 刷量 (never 容量, which is storage capacity; open question 11), Pyramid 金字塔, Ladder 阶梯, Grade Focus 专攻难度 |
| route (multi-frame)      | 长线路                          | Open question 12                                                      |
| rest timer               | 休息计时器                      |                                                                       |
| queue                    | 队列                            |                                                                       |
| logbook, history         | 攀爬记录                        |                                                                       |
| playlist                 | 线路清单                        | Open question 5                                                       |
| light up                 | 点亮                            |                                                                       |
| take the wall            | 接管这面墙                      | Open question 6                                                       |
| recap                    | 总结                            |                                                                       |
| Bluetooth                | 蓝牙                            |                                                                       |
| Lock Screen              | 锁屏                            | Apple's own term                                                      |
| Live Activity            | 实时活动                        | Apple's own term                                                      |
| Dynamic Island           | 灵动岛                          | Apple's own term                                                      |
| Apple Health             | Apple“健康”                     | Apple's own term for the app                                          |
| widget                   | 小组件                          | Apple's own term                                                      |
| free, no ads             | 免费，无广告                    |                                                                       |
| open source              | 开源                            |                                                                       |

## Keep these in English (do **not** translate)

- **Brand and product names:** `Boardsesh`, `Kilter`, `Tension`, `MoonBoard`, `Woods`, `Woods Board`, `Decoy`, `Touchstone`, `Grasshopper`, `So iLL`, `Aurora Climbing`, `GitHub`, `Aura` (the board look). Mainland climbers do use nicknames such as `月板` for MoonBoard; those may appear in `keywords.txt` so a search finds the app, never in listing prose.
- **`App`, `LED`, `iOS`, `Android`, `Flash`, `beta`.**
- Board sizes and model years: `12x12`, `8x10`, `Masters 2017`.

## Trademark wording

Same rule as every other locale: describe compatibility, never affiliation.

- **兼容** and **可与…配合使用** for "works with".
- Never `官方` (official), `授权` (authorised), `合作` (partnered) or `Kilter App` style phrasing.
- The closing disclaimer is fixed: `Boardsesh 是一个社区项目，可与这些训练板配合使用，与任何训练板厂商均无关联，也未获其认可。`

## Store listing rules

- No donation or payment mentions in store text.
- Character caps are counted in characters, and Chinese runs far shorter than English: name 30, subtitle 30, keywords 100, promotional text 170, Play title 30, short description 80, Play changelog 500. `scripts/store-metadata-limits.test.ts` enforces them and the file-set parity with `en-US`.
- Write Chinese search keywords rather than translating the English ones. Do not repeat a word already in the name or subtitle.

## Open questions for the reviewer

These are the choices an agent cannot verify. Each one changes several strings.

1. **The everyday word for a board.** The text uses `训练板`. Candidates: `攀岩板`, `智能板`, `灯板`, `系统板`, or simply `板`. Which one would a climber at a mainland gym say out loud, and does `训练板` read as a hangboard to anyone?
2. **Session.** The text uses `训练` (`开一场训练`), which collides with `训练计划` for a workout. Is there a better word for "a few of us climbing one board together tonight"?
3. **Crew.** `岩友` is safe and a little formal. Would `搭子` / `岩搭子` or `小伙伴` be closer to how people talk, or too trendy for a store page?
4. **Flash.** Kept as `Flash`. Is `一次完攀` or `闪` what people say or write?
5. **Playlist.** `线路清单`, against `线路单`, `线路合集` or `歌单`-style `线单`.
6. **Take the wall.** `接管这面墙` is a literal reading of a feature name. Does it make sense without seeing the feature?
7. **Match.** `并手` for a matching rule on a hold. Is `并点` or `match` more common on boards?
8. **Send.** `完攀` is the standard written term. Do board climbers write `完成`, `红点` or `send` instead?
9. **Search keywords.** Which words do people type to find a board app: `月板`, `K板`, `智能板`, `攀岩板`? The keyword field has about 20 characters left.
10. **Tab and button names.** The listing glosses `Progress（进度）`, `Discover（发现）`, `Climbs（线路）`, `Previous（上一条）`, `Next（下一条）` and `Rest timer（休息计时器）`. The app catalogs must use the same Chinese once they are translated.
11. **Volume (workout type).** The text uses `刷量`. Is `量训练` or `训练量` what a climber would call a high-volume session, and is `刷量` too slangy for a store page?
12. **Route.** A route on a board is a longer climb played frame by frame, as opposed to a boulder. The text uses `长线路`. Is `路线`, `耐力线` or plain `Route` clearer?

## Process

- The listing folders must keep the exact `en-US` file set. URLs and the app name are copied unchanged.
- Update the Chinese release notes with every release, next to the other locales (`docs/mobile-store-release.md`). They are translated from the `en-US` notes on `release/next`, and the heading must name the version that is being prepared.
- **Chinese notes must name the same version as the `en-US` notes on the branch you merge into.** The `ios metadata` lane writes every locale folder onto whichever App Store version is editable; it does not look at the version in `app.config.ts`. A push to `main` while the train's version is in Prepare for Submission overwrites that draft's What's New in every locale with `main`'s text.
- See `docs/i18n-german-glossary.md`, `docs/i18n-french-glossary.md` and `docs/i18n-spanish-glossary.md` for the counterparts.
