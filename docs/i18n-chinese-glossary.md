# Simplified Chinese terminology and native-speaker questionnaire (2.8.0)

Boardsesh 2.8.0 adds AI-assisted Mandarin translations in Simplified Chinese
(`zh-CN`, displayed as 中文（简体）). These are provisional translations, not a
native-speaker-reviewed glossary. All 23 shared catalogs cover web and mobile;
mobile bundles only its existing 13 namespaces. iOS permission prompts use
`zh-Hans`. Simplified Chinese device preferences select this catalog; Traditional
Chinese preferences continue to the next supported device language.

## Working vocabulary

Use the same term across catalogs until native-speaker feedback establishes a
better one. Keep Boardsesh, Kilter, Tension, MoonBoard and manufacturer product
names unchanged. A completed climb, lighting a climb on the board, and posting a
message are different actions: do not translate all three as “发送”. Preserve
interpolation placeholders, markup and code examples exactly.

The log-ascent sheet accepts attempts and successful climbs, so its heading is
“记录攀爬”, not “记录完攀”. In the Unrepeated filter and estimated-grade caption,
zero recorded ascents means “暂无完攀记录”; it does not mean nobody attempted the
climb. Kilter circuits imported as collections are “训练线路组”, distinct from
multi-frame routes. A gym listing is one gym’s “资料” or one “岩馆记录”; “列表”
means a list of records and is misleading in ownership or merge confirmations.

| English concept | Provisional Chinese | Meaning in Boardsesh |
| --- | --- | --- |
| Climb / boulder problem | 线路 | An individual problem to climb |
| Board | 训练板 | The physical training board |
| Hold | 岩点 | A handhold or foothold |
| Send | 完攀 | Finishing a climb successfully |
| Flash | 一次完攀 | Finishing on the first attempt; beta is allowed |
| Attempt | 尝试 | A go on a climb, successful or unsuccessful |
| Beta | 攀爬方法 | How to do the moves, including a video |
| Project | 攻克目标 | A climb someone is working toward |
| Setter | 定线员 | The person who creates a climb |
| Queue | 队列 | The ordered list of climbs to play |
| Tick / log entry | 攀爬记录 | A saved ascent or attempt |
| Session | 攀爬活动 | A period of climbing, solo or together |
| Crew | 伙伴 | The people climbing together |
| Spraywall | 喷点墙 | A wall with many holds and overlapping climbs |
| Benchmark | 基准线路 | A reference climb used to compare difficulty |
| Campus | 无脚攀爬 | Climbing without using feet |
| Matching | 并手 | Placing both hands on the same hold |
| Kickboard / kicker | 踢脚板 | The lower, usually vertical foot section |

## Google Form draft

The form has deliberately not been created yet. The following copy and questions
are ready to transfer into Google Forms after reviewing the translators’ choices.
Ask people to answer only the terms they know. Keep terminology questions optional
and avoid requiring a Google sign-in or collecting email addresses automatically.

**Title:** 帮 Boardsesh 说好攀岩中文

**Description:**

Boardsesh 2.8.0 有简体中文版了！我们借助 AI 翻译了应用，但攀岩术语还需要
真正攀岩的人把关。你和岩友平时怎么说？请帮我们把中文改得更自然。
不必每题都答，只填你熟悉的词就好。问卷完全自愿，不影响使用应用。

### Questions 1–3: your climbing language

1. **你平时主要在哪个地区攀岩？** Short answer, optional. Example help:
   中国大陆、新加坡、马来西亚或其他地区；不需要填写具体岩馆或住址。
2. **你和岩友平时用哪种语言或中文说法交流？** Short answer, optional.
   Help: 普通话、其他中文方言，或中英混用都可以。
3. **你平时最常玩哪种训练板或岩壁？** Checkboxes: Kilter Board, Tension Board,
   MoonBoard, 喷点墙 / Spraywall, 其他. Optional.

### Questions 4 onward: terminology

Create one paragraph-response question for each row below. Use this instruction
above the questions:

**请写出你和岩友真正会用的说法。如果平时直接说英文，也请告诉我们。
如果中文在按钮里和聊天里有不同说法，可以分别举例。**

These candidates come from the translator subagents’ uncertainty reports. The
alternatives are discussion prompts, not endorsed translations. Include the
English concept so respondents can correct the proposed Chinese without having
to guess what it means.

| Question title | Help text / UI context | Alternatives raised by translators |
| --- | --- | --- |
| “Send”：成功爬完一条线路，你会怎么说？ | 目前用「完攀」。例如攀爬记录里的完成状态。 | 完成、登顶、完攀 |
| “Flash”：第一次尝试就完成线路，你会怎么说？ | 目前用「一次完攀」。与不看攀爬方法的 onsight 区分。 | 闪攀、一把过、Flash |
| “Beta”：完成线路的动作或方法，你会怎么说？ | 目前用「攀爬方法」。例如线路下面的方法视频。 | 解法、动作、攀爬攻略、Beta |
| “Project / projecting”：反复尝试、还想攻克的线路，你会怎么说？ | 目前用「攻克目标」。例如个人页面里还没完成的线路。 | 磕线、待攻克线路、项目 |
| “Climb / boulder problem”：训练板上的一条题目，你会怎么说？ | 目前用「线路」。例如搜索线路、保存线路。 | 线路、抱石线路、题目 |
| “Board”：Kilter、Tension 这类训练设备，你会怎么称呼？ | 目前用「训练板」。与一面普通岩壁区分。 | 攀岩训练板、岩板、Board |
| “Spraywall”：岩点密集、可以自己编线路的岩壁，你会怎么称呼？ | 目前统一用「喷点墙」。 | 满点墙、密集岩点墙、自由岩点墙、Spraywall |
| “Hold”：用手抓或用脚踩的岩点，你会怎么说？ | 目前用「岩点」。 | 岩点、支点、点 |
| “Tick / logbook”：记录一次攀爬、查看历史，你会怎么说？ | 目前用「攀爬记录」。可能包含完攀和未完成的尝试。 | 打卡、攀爬记录、攀爬日志 |
| “Session”：一次自己或和朋友一起的攀爬，你会怎么说？ | 目前用「攀爬活动」。例如活动历史和共同控制训练板。 | 一场攀爬、攀爬活动、训练、Session |
| “Crew”：一起攀岩、共享队列的朋友，你会怎么称呼？ | 目前用「伙伴」。 | 岩友、伙伴、队友 |
| “Benchmark”：用来参考难度的代表性线路，你会怎么说？ | 目前用「基准线路」。例如线路筛选条件。 | 标杆线路、基准线路、Benchmark |
| “Campus”：只用手、不用脚爬线路，你会怎么说？ | 目前用「无脚攀爬」。例如线路规则。 | 无脚、纯手、Campus |
| “Matching”：双手放在同一个岩点上，你会怎么说？ | 目前用「并手」。例如「禁止并手」规则。 | 双手同点、同点换手、并手 |
| “Kickboard / kicker”：训练板底部的脚点区域，你会怎么说？ | 目前用「踢脚板」。例如是否允许使用底部脚点。 | 底脚板、底部脚板、底部踢脚板 |
| “Volume”：岩壁上的大块立体造型，你会怎么说？ | 目前用「大体积岩点」。与小岩点和墙面区分。 | 造型块、体积块、Volume |
| “Kiosk”：岩馆里让大家选线路、控制训练板的公共屏幕，你会怎么说？ | 目前用「展示终端」。与私人手机区分。 | 公共选线屏、岩馆终端、自助终端 |
| “Set screw”：防止岩点转动的辅助螺钉，你会怎么说？ | 目前用「止转螺钉」。出现在训练板制作说明里。 | 防转螺钉、止转螺丝 |
| “Drive the wall”：让新选的线路持续跟着亮起，你会怎么说？ | 目前用「控制岩壁」。强调控制期间选线会点亮，并不是开车。 | 连续点亮、自动跟随选线、控制训练板 |
| “Playlist”：保存并整理一组线路，你会怎么称呼？ | 目前用「线路集」。例如创建线路集、加入线路集。 | 线路清单、攀爬清单、Playlist |
| “Route / circuit”：训练板上有多个阶段的长线路，你会怎么说？ | 目前用「连续线路」。不是在说需要绳索的攀爬。 | 耐力线路、循环线路、连续线路 |
| “T-nut”：训练板背面固定螺栓的螺母，你会怎么说？ | 目前用「T 形螺母」。例如制作图里的螺母孔径。 | 四爪螺母、爪母、T 形螺母 |
| “Redpoint”：经过练习后成功完成线路，你会怎么说？ | 与第一次尝试就完成的 Flash 区分。 | 红点完攀、非首次完攀、Redpoint |
| “Repeat”：再次完成以前已经完成过的线路，你会怎么说？ | 指同一个攀爬者再次完成，不是线路的总完攀人数。 | 复攀、重复完攀、Repeat |
| “Consensus grade”：根据岩友的评价得出的难度，你会怎么说？ | 与定线员最初给出的难度区分。 | 共识难度、大家评出的难度 |
| “Crimp”：需要用手指抠住的小边点，你会怎么说？ | 这里指岩点类型，不是要求你使用某一种手指姿势。 | 抠点、小边点、Crimp |
| “Tall climbs”：训练板里较高的线路，你会怎么说？ | 这是线路筛选条件，不是在问攀爬者的身高。 | 到顶线路、高线路 |
| “Set angle”：定线时使用的训练板角度，你会怎么说？ | 与你此刻正在攀爬的角度区分。 | 定线角度、设定角度 |

### Final question

**还有哪些中文读起来不自然、容易误解，或你更习惯保留英文的词？**
Paragraph, optional. Help: 可以写「应用里的原话 → 你建议的说法」，也可以说明
是在什么页面看到的。请不要填写密码、账号信息或他人的个人信息。

**Confirmation message:** 谢谢你帮 Boardsesh 把中文说得更地道！我们会结合岩友的
建议统一术语。现在可以回到应用继续攀爬了。

## Welcome and form wiring

Chinese users receive a skippable welcome on the website and in the app. It is
independent of first-board setup, so existing users who switch to Chinese are
included. Dismissal is stored on the device/browser. The mobile prompt waits for
launch readiness and consent, and runs on tabs or General settings rather than
over sign-in or board setup. Other locales never receive this prompt.

While no form URL is configured, the welcome explicitly says the questionnaire
is being prepared; it offers Continue and points to the existing Help translate
action. It never opens a placeholder URL. Once a real form URL is configured,
an independent dismissal key invites those early visitors once more. The app’s
Settings → General → Help translate action then opens the form for Chinese users.

Set `EXPO_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL` for the native and Expo web bundle,
and `NEXT_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL` for www, to the same Google Form
respondent URL (`https://forms.gle/…` or `https://docs.google.com/forms/…`). Both are
public build-time values; rebuild the corresponding bundles after setting them.
No responses or account details are sent automatically: opening and submitting
the form are the climber’s choices. The native localization declaration belongs
in the 2.8.0 binary; an OTA alone cannot add iOS permission translations.

Existing locale-driven website routing, language menus, canonical/hreflang
metadata and sitemap expansion pick up `zh-CN` from `SUPPORTED_LOCALES`. This
change adds no route or new indexable page type.
