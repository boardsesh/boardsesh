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
| Redpoint | 红点完攀 | A successful ascent after previous attempts |
| Repeat | 重复完攀 | The same climber completes a previously completed climb again |
| Consensus grade | 共识难度 | Community-assessed difficulty, distinct from the setter’s initial grade |
| Crimp | 抠点 | A small edge hold, not a required finger posture |
| Tall climbs | 高线路 | Climbs unavailable on a shorter board of the same layout; top-row use is not required |
| Set angle | 设置角度 | The board angle at which a climb was set, distinct from the current climbing angle |
| Multi-stage route | 连续线路 | One climb whose groups of lit holds change in sequence |
| Imported Kilter circuit | 训练线路组 | A collection of several climbs, distinct from a multi-stage route |

## Google Form questionnaire

The shared [terminology form generator](../../scripts/create-terminology-form.gs)
contains the reviewed Chinese profile: 32 optional questions in five sections,
with all 28 terminology topics below. Use `TERMINOLOGY_FORM_LOCALE = 'zh-CN'`
and run **`createTerminologyForm`** in the same Apps Script project as the
existing draft. This reuses its saved ID and resumes its pending checkbox with
the five intended choices automatically.

The [form setup and language profile guide](i18n-terminology-forms.md) covers the
single-script workflow, reruns, adding another language, and publishing/access
checks. The generator leaves a draft; a public respondent URL still requires
owner verification before it is configured in the app.

### Reviewed questionnaire copy

**Title:** 帮 Boardsesh 说好攀岩中文

**Description:** Boardsesh 2.8.0 的简体中文翻译用到了 AI。我们想听听，你和岩友在岩馆里会怎么说。所有题目都可跳过，挑几个熟悉的词回答就好。直接用英文也欢迎。填写问卷完全自愿，不影响使用应用。

请勿填写姓名、邮箱、手机号、账号、密码或他人的个人信息。

Every answer below is optional. Term questions use paragraph responses; the two
language-background answers use short text and the board question uses checkboxes.
Candidate alternatives are discussion prompts, not endorsed translations.


### 你平时怎么爬？

这些背景问题也都可以跳过。不需要填写具体岩馆或住址。

| Question title | Type | Help text |
| --- | --- | --- |
| 你平时主要在哪个地区攀岩？ | 简答（可选） | 例如中国大陆、新加坡、马来西亚或其他地区；不需要填写具体岩馆或住址。 |
| 你和岩友平时用哪些语言或方言交流？ | 简答（可选） | 普通话、其他中文方言，或中英混用都可以。 |
| 你平时常爬哪些训练板或岩壁？（可多选） | 多选（可选） | 选你熟悉的就好，也可以跳过。 选项：Kilter Board、Tension Board、MoonBoard、喷点墙 / Spraywall、其他。 |

### 攀爬和记录

请写出你和岩友真正会用的说法。如果平时直接说英文，也请告诉我们。按钮和聊天里的说法不一样时，可以分别举例。

| Question title | Type | Help text |
| --- | --- | --- |
| Send｜成功爬完一条线路，你会怎么说？ | 段落（可选） | 我们暂用「完攀」，例如攀爬记录里的完成状态。 可供比较的说法（不是标准答案）：完成、登顶、完攀。 |
| Flash｜第一次尝试一条线路就完攀，你会怎么说？ | 段落（可选） | 我们暂用「一次完攀」。第一次上手前可以看过别人爬，也可以听过动作提示。 可供比较的说法（不是标准答案）：闪攀、一把过、Flash。 |
| Redpoint｜一条线路之前试过，这次从头到尾爬成了，你会怎么说？ | 段落（可选） | 我们暂用「红点完攀」，与第一次尝试就完成的 Flash 区分。 可供比较的说法（不是标准答案）：红点完攀、非首次完攀、Redpoint。 |
| Repeat｜以前爬成过的线路，这次又爬成了，你会怎么说？ | 段落（可选） | 我们暂用「重复完攀」。指同一个攀爬者再次完成，不是线路的总完攀人数。 可供比较的说法（不是标准答案）：复攀、重复完攀、Repeat。 |
| Beta｜一条线路怎么爬、某个动作怎么做，你会用什么词来讲这些方法？ | 段落（可选） | 我们暂用「攀爬方法」，例如线路下面的方法视频。 可供比较的说法（不是标准答案）：解法、动作、攀爬攻略、Beta。 |
| Project / projecting｜一条还没爬成、想继续试的线路，你会怎么叫？反复练这条线，你又会怎么说？ | 段落（可选） | 我们暂用「攻克目标」，例如个人页面里还没完成的线路。 可供比较的说法（不是标准答案）：磕线、待攻克线路、项目。 |
| Tick / logbook｜记下一次攀爬（Tick），以及用来看这些记录的地方（Logbook），你分别怎么叫？ | 段落（可选） | 我们暂用「攀爬记录」，可能包含完攀和未完成的尝试。 可供比较的说法（不是标准答案）：打卡、攀爬记录、攀爬日志。 |
| Session｜自己或和朋友从开始爬到收工的这段时间，你会怎么说？ | 段落（可选） | 我们暂用「攀爬活动」，例如活动历史和共同控制训练板。 可供比较的说法（不是标准答案）：一场攀爬、攀爬活动、训练、Session。 |
| Crew｜平时和你一起爬、轮流选线路的这群人，你会怎么称呼？ | 段落（可选） | 我们暂用「伙伴」，例如一起攀岩、共享队列的朋友。 可供比较的说法（不是标准答案）：岩友、伙伴、队友。 |

### 线路和难度

只回答你熟悉的概念就好；候选说法都还需要岩友确认。

| Question title | Type | Help text |
| --- | --- | --- |
| Climb / boulder problem｜训练板上单独编好的一条攀爬线路，你会怎么叫？ | 段落（可选） | 我们暂用「线路」，例如搜索线路、保存线路。 可供比较的说法（不是标准答案）：线路、抱石线路、题目。 |
| Benchmark｜用来对照难度的代表性线路，你会怎么叫？ | 段落（可选） | 我们暂用「基准线路」，例如线路筛选条件。 可供比较的说法（不是标准答案）：标杆线路、基准线路、Benchmark。 |
| Consensus grade｜岩友们给一条线路评出的总体难度，你会怎么说？ | 段落（可选） | 我们暂用「共识难度」，与定线员最初给出的难度区分。 可供比较的说法（不是标准答案）：共识难度、大家评出的难度。 |
| Tall climbs｜有些线路换到同一布局的矮款训练板就爬不了。筛选这类线路时，你希望按钮上写什么？ | 段落（可选） | 我们暂用「高线路」。比如，一条线路用到了矮款训练板上没有的高处岩点；不要求用到最顶排，也不是指攀爬者身高。 可供比较的说法（不是标准答案）：到顶线路、高线路。 |
| Set angle｜一条线路是在哪个训练板角度定出来的？你会怎么称呼这个角度？ | 段落（可选） | 我们暂用「设置角度」，与此刻正在攀爬的角度区分。 可供比较的说法（不是标准答案）：定线角度、设定角度。 |
| Route / circuit｜训练板上按顺序换几组亮点、连起来爬的一条线路（Route），和 Kilter 里收在一组的多条线路（Circuit），你分别怎么叫？ | 段落（可选） | 前者暂用「连续线路」，后者暂用「训练线路组」。只熟悉其中一种也可以回答；不是在说需要绳索的攀爬。 可供比较的说法（不是标准答案）：耐力线路、连续线路、训练线路组、Circuit。 |
| Playlist｜把多条线路保存到一起、排好顺序，你会怎么称呼这样的清单？ | 段落（可选） | 我们暂用「线路集」，例如创建线路集、加入线路集。 可供比较的说法（不是标准答案）：线路清单、攀爬清单、Playlist。 |

### 岩点和动作

描述你平时会怎么说即可，不需要选择候选词。

| Question title | Type | Help text |
| --- | --- | --- |
| Hold｜岩壁上用手抓或用脚踩的点，你平时怎么叫？ | 段落（可选） | 我们暂用「岩点」。 可供比较的说法（不是标准答案）：岩点、支点、点。 |
| Crimp｜岩点上只有一道窄边，手指只能扣住这道边。你会怎么叫这种点？ | 段落（可选） | 我们暂用「抠点」。这里指岩点类型，不是要求你使用某一种手指姿势。 可供比较的说法（不是标准答案）：抠点、小边点、Crimp。 |
| Campus｜爬一条线路时只用手、不用脚，你会怎么说？ | 段落（可选） | 我们暂用「无脚攀爬」，例如线路规则。 可供比较的说法（不是标准答案）：无脚、纯手、Campus。 |
| Matching｜两只手同时抓住同一个岩点，你会怎么说？ | 段落（可选） | 我们暂用「并手」，例如「禁止并手」规则。不是只把一只手换成另一只手。 可供比较的说法（不是标准答案）：双手同点、并手。 |

### 训练板和岩壁

制作和控制训练板的词也可以跳过，最后还可以补充其他建议。

| Question title | Type | Help text |
| --- | --- | --- |
| Board｜Kilter、Tension 这类训练设备，你平时怎么叫？ | 段落（可选） | 我们暂用「训练板」，与一面普通岩壁区分。 可供比较的说法（不是标准答案）：攀岩训练板、岩板、Board。 |
| Spraywall｜一面布满岩点、可以自己编线路的墙，你会怎么叫？ | 段落（可选） | 我们暂用「喷点墙」。 可供比较的说法（不是标准答案）：满点墙、密集岩点墙、自由岩点墙、Spraywall。 |
| Kickboard / kicker｜训练板底部那块通常竖直、装有脚点的板，你会怎么叫？ | 段落（可选） | 我们暂用「踢脚板」，例如是否允许使用底部脚点。 可供比较的说法（不是标准答案）：底脚板、底部脚板、底部踢脚板。 |
| Volume｜岩壁上凸出的一大块立体造型，有时上面还能再装岩点，你会怎么叫？ | 段落（可选） | 我们暂用「大体积岩点」，与小岩点和墙面区分。 可供比较的说法（不是标准答案）：造型块、体积块、Volume。 |
| Kiosk｜岩馆里用来给大家显示当前线路和队列的公共屏幕，你会怎么叫？ | 段落（可选） | 我们暂用「展示终端」，与私人手机区分。 可供比较的说法（不是标准答案）：公共选线屏、岩馆终端、自助终端。 |
| Drive the wall｜你在手机上选哪条线路，训练板就跟着点亮哪条。你会怎么称呼这种控制方式？ | 段落（可选） | 我们暂用「控制岩壁」。强调控制期间选线会点亮，并不是开车。 可供比较的说法（不是标准答案）：连续点亮、自动跟随选线、控制训练板。 |
| Set screw｜除了固定岩点的主螺栓，还用一颗小螺钉防止岩点转动。你会怎么叫这颗小螺钉？ | 段落（可选） | 我们暂用「止转螺钉」，出现在训练板制作说明里。 可供比较的说法（不是标准答案）：防转螺钉、止转螺丝。 |
| T-nut｜装在训练板背面、让岩点螺栓拧进去的螺母，你会怎么叫？ | 段落（可选） | 我们暂用「T 形螺母」，例如制作图里的螺母孔径。 可供比较的说法（不是标准答案）：四爪螺母、爪母、T 形螺母。 |
| 还有哪些词读起来别扭、容易误解，或者你更习惯直接用英文？ | 段落（可选） | 可以写下应用里的原话、你会怎么说，以及在哪个页面看到的。请勿填写账号或个人联系方式。 |

**Confirmation message:** 谢谢！我们会参考你和其他岩友的说法，改进 Boardsesh 的简体中文翻译。

## Welcome and form wiring

Chinese users receive a skippable welcome on the website and in the app. It is
independent of first-board setup, so existing users who switch to Chinese are
included. Dismissal is stored on the device/browser. The mobile prompt waits for
launch readiness and consent, and runs on tabs or General settings rather than
over sign-in or board setup. Other locales never receive this prompt.

The published [Chinese terminology questionnaire](https://docs.google.com/forms/d/e/1FAIpQLSewiiQkpQG5bT2UVYEdqDRmeSSs26h50xJLrR-rYORuZIj17g/viewform)
is the shared default for native, Expo web, and www. It was checked anonymously:
the public page loads with all 32 optional questions and the five intended board
choices. No answers were submitted as part of that check.

The welcome offers the form, and its separate dismissal key invites people who
previously saw the preparation message once more. Chinese users can also open
the form through Settings → General → Help translate, or the account sheet's
Help translate row beneath their profile. That row shares the support group
with donations but remains visible independently of donation/storefront rules.
Other languages keep their existing translation contribution flow.

`EXPO_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL` for native/Expo web and
`NEXT_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL` for www optionally override this default.
An explicit empty or invalid override disables the form and shows the preparation
message instead. These are public build-time values; ship an updated JS bundle
or web deployment when changing them. The checked-in default needs no environment
configuration and can reach existing native installs through an OTA.
No responses or account details are sent automatically: opening and submitting
the form are the climber’s choices. The native localization declaration belongs
in the 2.8.0 binary; an OTA alone cannot add iOS permission translations.

Existing locale-driven website routing, language menus, canonical/hreflang
metadata and sitemap expansion pick up `zh-CN` from `SUPPORTED_LOCALES`. This
change adds no route or new indexable page type.
