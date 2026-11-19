/**
 * Copy this entire file into a standalone Google Apps Script project, then run
 * createTerminologyForm. It creates an UNPUBLISHED draft, never publishes
 * or grants responder/Drive permissions, and never reads or deletes responses.
 * The owner reviews and publishes in Google Forms, then tests signed-out access.
 *
 * Rerun in the SAME script project to resume. Keep ScriptProperties intact.
 * If creation was interrupted before the draft ID was saved, inspect the prior
 * execution log / Google Forms, then paste that EMPTY, UNPUBLISHED draft's ID
 * below. Recovery never searches Drive or guesses which form belongs to you.
 *
 * APIs: https://developers.google.com/apps-script/reference/forms/form-app
 *       https://developers.google.com/apps-script/reference/forms/form
 */
var TERMINOLOGY_FORM_LOCALE = 'zh-CN';
var TERMINOLOGY_RECOVER_DRAFT_ID = '';
var TERMINOLOGY_FORM_PROFILES = {
  'zh-CN': {
    title: '帮 Boardsesh 说好攀岩中文',
    description:
      'Boardsesh 2.8.0 的简体中文翻译用到了 AI。我们想听听，你和岩友在岩馆里会怎么说。' +
      '所有题目都可跳过，挑几个熟悉的词回答就好。直接用英文也欢迎。' +
      '填写问卷完全自愿，不影响使用应用。\n\n' +
      '请勿填写姓名、邮箱、手机号、账号、密码或他人的个人信息。',
    confirmation: '谢谢！我们会参考你和其他岩友的说法，改进 Boardsesh 的简体中文翻译。',
    buildPlan: chineseTerminologyPlan_,
  },
};

function createTerminologyForm() {
  var locale = TERMINOLOGY_FORM_LOCALE;
  if (typeof locale !== 'string' || !Object.prototype.hasOwnProperty.call(TERMINOLOGY_FORM_PROFILES, locale))
    throw new Error('Unsupported terminology form locale: ' + JSON.stringify(locale));
  var profile = TERMINOLOGY_FORM_PROFILES[locale];
  var stateKey =
    locale === 'zh-CN' ? 'BOARDSESH_CHINESE_TERMINOLOGY_FORM_V1' : 'BOARDSESH_TERMINOLOGY_FORM_V1_' + locale;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another creation is running. Rerun later in this same project.');
  try {
    var properties = PropertiesService.getScriptProperties();
    var saved = properties.getProperty(stateKey);
    var state = saved ? JSON.parse(saved) : null;
    var plan = profile.buildPlan();
    var signature = terminologyFormSignature_(plan);
    var firstCreation = !state;
    if (!state) {
      state = {
        version: 1,
        signature: signature,
        formId: null,
        configured: false,
        itemIds: [],
        pending: null,
        complete: false,
      };
      // Write intent BEFORE creation. An uncertain result must never create a duplicate draft.
      terminologyFormSave_(properties, stateKey, state);
    }
    if (state.version !== 1 || state.signature !== signature)
      throw new Error('Saved questionnaire differs. Keep the original script; do not clear its properties.');
    if (!state.configured && (state.pending || state.itemIds.length > 0))
      throw new Error('Unconfigured draft has item checkpoints. Review the saved state; nothing was changed.');
    var configuredAtStart = state.configured === true;
    var form;
    var createdHere = false;
    if (!state.formId) {
      if (firstCreation) {
        form = FormApp.create(profile.title, false);
        createdHere = true;
        console.log('RECOVERY draft ID: ' + form.getId() + '\nDraft edit URL: ' + form.getEditUrl());
      } else {
        if (!TERMINOLOGY_RECOVER_DRAFT_ID)
          throw new Error(
            'Creation outcome is uncertain. Find the prior empty unpublished draft in the execution log / Google Forms, set TERMINOLOGY_RECOVER_DRAFT_ID, and rerun. Do not clear ScriptProperties.',
          );
        form = FormApp.openById(TERMINOLOGY_RECOVER_DRAFT_ID);
        if (
          String(form.getTitle()) !== profile.title ||
          !form.supportsAdvancedResponderPermissions() ||
          form.isPublished() ||
          form.getItems().length
        ) {
          throw new Error('Recovery requires the matching EMPTY, UNPUBLISHED draft. Nothing was changed.');
        }
      }
      state.formId = form.getId();
      terminologyFormSave_(properties, stateKey, state);
    } else {
      form = FormApp.openById(state.formId);
    }
    // Completed reruns are read-only, including after the owner edits or publishes.
    if (state.complete) return terminologyFormReport_(form, true);
    if (!form.supportsAdvancedResponderPermissions() || form.isPublished())
      throw new Error('Resume only an unpublished draft that supports publishing. Nothing was added.');
    // Explicitly initialize the new draft title before checking resumed drafts.
    // Its ID is already checkpointed, so a setter failure cannot create another form.
    if (createdHere) form.setTitle(profile.title);
    var actualTitle = String(form.getTitle());
    if (actualTitle !== profile.title) {
      if (
        TERMINOLOGY_RECOVER_DRAFT_ID === state.formId &&
        state.configured === false &&
        state.itemIds.length === 0 &&
        state.pending === null &&
        form.getItems().length === 0
      ) {
        // Explicit owner recovery only: never rename a configured or nonempty form.
        form.setTitle(profile.title);
        actualTitle = String(form.getTitle());
      }
      if (actualTitle !== profile.title)
        throw new Error(
          'Draft title mismatch: actual ' +
            JSON.stringify(actualTitle) +
            '; expected ' +
            JSON.stringify(profile.title) +
            '. Existing drafts are not renamed automatically. Review the heading manually, or use the matching TERMINOLOGY_RECOVER_DRAFT_ID only for an empty, unconfigured, unpublished saved draft.',
        );
    }
    terminologyFormCheckPrefix_(form.getItems(), state, plan);
    if (!state.configured) {
      form.setPublished(false);
      form.setCollectEmail(false);
      form.setLimitOneResponsePerUser(false);
      form.setPublishingSummary(false);
      form.setIsQuiz(false);
      form.setShuffleQuestions(false);
      form.setProgressBar(true);
      form.setDescription(profile.description);
      form.setConfirmationMessage(profile.confirmation);
      state.configured = true;
      terminologyFormSave_(properties, stateKey, state);
    }
    if (
      form.collectsEmail() ||
      form.hasLimitOneResponsePerUser() ||
      form.isPublishingSummary() ||
      form.isQuiz() ||
      form.getShuffleQuestions() ||
      !form.hasProgressBar()
    ) {
      throw new Error(
        'Draft settings were changed. Review privacy / progress settings in Google Forms before resuming.',
      );
    }
    var startedAt = Date.now();
    while (state.itemIds.length < plan.length) {
      var index = state.itemIds.length;
      var definition = plan[index];
      var items = form.getItems();
      terminologyFormCheckPrefix_(items, state, plan);
      var item;
      var createdItemHere = false;
      var knownPendingHere = false;
      if (state.pending) {
        if (items.length !== index + 1)
          throw new Error(
            'An item creation has an uncertain result. Inspect the draft; only if the next item is missing, add one blank ' +
              definition.type +
              ' item at the end and rerun. Do not clear ScriptProperties.',
          );
        item = items[index];
        if (state.pending.id !== null && String(item.getId()) !== state.pending.id)
          throw new Error('Pending item identity changed. Nothing was overwritten.');
        knownPendingHere = state.pending.id !== null;
      } else {
        state.pending = { index: index, id: null };
        terminologyFormSave_(properties, stateKey, state);
        item = terminologyFormAdd_(form, definition.type);
        createdItemHere = true;
        state.pending.id = String(item.getId());
        terminologyFormSave_(properties, stateKey, state);
      }
      // add* returns a concrete typed object; only generic Item has as* casts.
      terminologyFormConfigureItem_(
        form.getItemById(item.getId()),
        definition,
        createdItemHere,
        configuredAtStart && knownPendingHere,
      );
      // Validate an unknown tail before recording ownership of its ID. A refused
      // owner edit must remain unknown on every retry, never gain normalization rights.
      if (state.pending.id === null) {
        state.pending.id = String(item.getId());
        terminologyFormSave_(properties, stateKey, state);
      }
      state.itemIds.push(String(item.getId()));
      state.pending = null;
      terminologyFormSave_(properties, stateKey, state);
      if (Date.now() - startedAt > 240000) return terminologyFormReport_(form, false);
    }
    terminologyFormCheckPrefix_(form.getItems(), state, plan);
    state.complete = true;
    terminologyFormSave_(properties, stateKey, state);
    return terminologyFormReport_(form, true);
  } finally {
    lock.releaseLock();
  }
}

/** 28 terminology topics, three background questions and one final comment. */
function chineseTerminologyPlan_() {
  var plan = [];
  function section(key, title, help) {
    plan.push({ key: key, type: plan.length ? 'PAGE_BREAK' : 'SECTION_HEADER', title: title, help: help });
  }
  function question(key, type, title, help, choices) {
    plan.push({ key: key, type: type, title: title, help: help, choices: choices || [] });
  }
  function term(key, title, help, alternatives) {
    question(key, 'PARAGRAPH_TEXT', title, help + '\n可供比较的说法（不是标准答案）：' + alternatives + '。');
  }
  section('background', '你平时怎么爬？', '这些背景问题也都可以跳过。不需要填写具体岩馆或住址。');
  question(
    'region',
    'TEXT',
    '你平时主要在哪个地区攀岩？',
    '例如中国大陆、新加坡、马来西亚或其他地区；不需要填写具体岩馆或住址。',
  );
  question('language', 'TEXT', '你和岩友平时用哪些语言或方言交流？', '普通话、其他中文方言，或中英混用都可以。');
  question('boards', 'CHECKBOX', '你平时常爬哪些训练板或岩壁？（可多选）', '选你熟悉的就好，也可以跳过。', [
    'Kilter Board',
    'Tension Board',
    'MoonBoard',
    '喷点墙 / Spraywall',
    '其他',
  ]);

  section(
    'climbing-records',
    '攀爬和记录',
    '请写出你和岩友真正会用的说法。如果平时直接说英文，也请告诉我们。按钮和聊天里的说法不一样时，可以分别举例。',
  );
  term(
    'send',
    'Send｜成功爬完一条线路，你会怎么说？',
    '我们暂用「完攀」，例如攀爬记录里的完成状态。',
    '完成、登顶、完攀',
  );
  term(
    'flash',
    'Flash｜第一次尝试一条线路就完攀，你会怎么说？',
    '我们暂用「一次完攀」。第一次上手前可以看过别人爬，也可以听过动作提示。',
    '闪攀、一把过、Flash',
  );
  term(
    'redpoint',
    'Redpoint｜一条线路之前试过，这次从头到尾爬成了，你会怎么说？',
    '我们暂用「红点完攀」，与第一次尝试就完成的 Flash 区分。',
    '红点完攀、非首次完攀、Redpoint',
  );
  term(
    'repeat',
    'Repeat｜以前爬成过的线路，这次又爬成了，你会怎么说？',
    '我们暂用「重复完攀」。指同一个攀爬者再次完成，不是线路的总完攀人数。',
    '复攀、重复完攀、Repeat',
  );
  term(
    'beta',
    'Beta｜一条线路怎么爬、某个动作怎么做，你会用什么词来讲这些方法？',
    '我们暂用「攀爬方法」，例如线路下面的方法视频。',
    '解法、动作、攀爬攻略、Beta',
  );
  term(
    'project',
    'Project / projecting｜一条还没爬成、想继续试的线路，你会怎么叫？反复练这条线，你又会怎么说？',
    '我们暂用「攻克目标」，例如个人页面里还没完成的线路。',
    '磕线、待攻克线路、项目',
  );
  term(
    'tick-logbook',
    'Tick / logbook｜记下一次攀爬（Tick），以及用来看这些记录的地方（Logbook），你分别怎么叫？',
    '我们暂用「攀爬记录」，可能包含完攀和未完成的尝试。',
    '打卡、攀爬记录、攀爬日志',
  );
  term(
    'session',
    'Session｜自己或和朋友从开始爬到收工的这段时间，你会怎么说？',
    '我们暂用「攀爬活动」，例如活动历史和共同控制训练板。',
    '一场攀爬、攀爬活动、训练、Session',
  );
  term(
    'crew',
    'Crew｜平时和你一起爬、轮流选线路的这群人，你会怎么称呼？',
    '我们暂用「伙伴」，例如一起攀岩、共享队列的朋友。',
    '岩友、伙伴、队友',
  );

  section('routes-grades', '线路和难度', '只回答你熟悉的概念就好；候选说法都还需要岩友确认。');
  term(
    'climb',
    'Climb / boulder problem｜训练板上单独编好的一条攀爬线路，你会怎么叫？',
    '我们暂用「线路」，例如搜索线路、保存线路。',
    '线路、抱石线路、题目',
  );
  term(
    'benchmark',
    'Benchmark｜用来对照难度的代表性线路，你会怎么叫？',
    '我们暂用「基准线路」，例如线路筛选条件。',
    '标杆线路、基准线路、Benchmark',
  );
  term(
    'consensus-grade',
    'Consensus grade｜岩友们给一条线路评出的总体难度，你会怎么说？',
    '我们暂用「共识难度」，与定线员最初给出的难度区分。',
    '共识难度、大家评出的难度',
  );
  term(
    'tall-climbs',
    'Tall climbs｜有些线路换到同一布局的矮款训练板就爬不了。筛选这类线路时，你希望按钮上写什么？',
    '我们暂用「高线路」。比如，一条线路用到了矮款训练板上没有的高处岩点；不要求用到最顶排，也不是指攀爬者身高。',
    '到顶线路、高线路',
  );
  term(
    'set-angle',
    'Set angle｜一条线路是在哪个训练板角度定出来的？你会怎么称呼这个角度？',
    '我们暂用「设置角度」，与此刻正在攀爬的角度区分。',
    '定线角度、设定角度',
  );
  term(
    'route-circuit',
    'Route / circuit｜训练板上按顺序换几组亮点、连起来爬的一条线路（Route），和 Kilter 里收在一组的多条线路（Circuit），你分别怎么叫？',
    '前者暂用「连续线路」，后者暂用「训练线路组」。只熟悉其中一种也可以回答；不是在说需要绳索的攀爬。',
    '耐力线路、连续线路、训练线路组、Circuit',
  );
  term(
    'playlist',
    'Playlist｜把多条线路保存到一起、排好顺序，你会怎么称呼这样的清单？',
    '我们暂用「线路集」，例如创建线路集、加入线路集。',
    '线路清单、攀爬清单、Playlist',
  );

  section('holds-moves', '岩点和动作', '描述你平时会怎么说即可，不需要选择候选词。');
  term('hold', 'Hold｜岩壁上用手抓或用脚踩的点，你平时怎么叫？', '我们暂用「岩点」。', '岩点、支点、点');
  term(
    'crimp',
    'Crimp｜岩点上只有一道窄边，手指只能扣住这道边。你会怎么叫这种点？',
    '我们暂用「抠点」。这里指岩点类型，不是要求你使用某一种手指姿势。',
    '抠点、小边点、Crimp',
  );
  term(
    'campus',
    'Campus｜爬一条线路时只用手、不用脚，你会怎么说？',
    '我们暂用「无脚攀爬」，例如线路规则。',
    '无脚、纯手、Campus',
  );
  term(
    'matching',
    'Matching｜两只手同时抓住同一个岩点，你会怎么说？',
    '我们暂用「并手」，例如「禁止并手」规则。不是只把一只手换成另一只手。',
    '双手同点、并手',
  );

  section('boards-walls', '训练板和岩壁', '制作和控制训练板的词也可以跳过，最后还可以补充其他建议。');
  term(
    'board',
    'Board｜Kilter、Tension 这类训练设备，你平时怎么叫？',
    '我们暂用「训练板」，与一面普通岩壁区分。',
    '攀岩训练板、岩板、Board',
  );
  term(
    'spraywall',
    'Spraywall｜一面布满岩点、可以自己编线路的墙，你会怎么叫？',
    '我们暂用「喷点墙」。',
    '满点墙、密集岩点墙、自由岩点墙、Spraywall',
  );
  term(
    'kickboard',
    'Kickboard / kicker｜训练板底部那块通常竖直、装有脚点的板，你会怎么叫？',
    '我们暂用「踢脚板」，例如是否允许使用底部脚点。',
    '底脚板、底部脚板、底部踢脚板',
  );
  term(
    'volume',
    'Volume｜岩壁上凸出的一大块立体造型，有时上面还能再装岩点，你会怎么叫？',
    '我们暂用「大体积岩点」，与小岩点和墙面区分。',
    '造型块、体积块、Volume',
  );
  term(
    'kiosk',
    'Kiosk｜岩馆里用来给大家显示当前线路和队列的公共屏幕，你会怎么叫？',
    '我们暂用「展示终端」，与私人手机区分。',
    '公共选线屏、岩馆终端、自助终端',
  );
  term(
    'drive-wall',
    'Drive the wall｜你在手机上选哪条线路，训练板就跟着点亮哪条。你会怎么称呼这种控制方式？',
    '我们暂用「控制岩壁」。强调控制期间选线会点亮，并不是开车。',
    '连续点亮、自动跟随选线、控制训练板',
  );
  term(
    'set-screw',
    'Set screw｜除了固定岩点的主螺栓，还用一颗小螺钉防止岩点转动。你会怎么叫这颗小螺钉？',
    '我们暂用「止转螺钉」，出现在训练板制作说明里。',
    '防转螺钉、止转螺丝',
  );
  term(
    't-nut',
    'T-nut｜装在训练板背面、让岩点螺栓拧进去的螺母，你会怎么叫？',
    '我们暂用「T 形螺母」，例如制作图里的螺母孔径。',
    '四爪螺母、爪母、T 形螺母',
  );
  question(
    'final-comment',
    'PARAGRAPH_TEXT',
    '还有哪些词读起来别扭、容易误解，或者你更习惯直接用英文？',
    '可以写下应用里的原话、你会怎么说，以及在哪个页面看到的。请勿填写账号或个人联系方式。',
  );
  return plan;
}

function terminologyFormSave_(properties, stateKey, state) {
  properties.setProperty(stateKey, JSON.stringify(state));
}

function terminologyFormSignature_(plan) {
  // Detect accidental questionnaire edits across partial runs, not a security hash.
  var text = JSON.stringify(plan);
  var hash = 2166136261;
  for (var index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
}

function terminologyFormCheckPrefix_(items, state, plan) {
  var completed = state.itemIds.length;
  if (items.length < completed || items.length > completed + (state.pending ? 1 : 0))
    throw new Error('Draft items were added or removed outside this run. Nothing was deleted or overwritten.');
  for (var index = 0; index < completed; index++) {
    if (
      String(items[index].getId()) !== state.itemIds[index] ||
      items[index].getType() !== FormApp.ItemType[plan[index].type]
    ) {
      throw new Error('A completed item was moved or changed type. Review it manually; nothing was overwritten.');
    }
    var type = plan[index].type;
    var question =
      type === 'TEXT'
        ? items[index].asTextItem()
        : type === 'CHECKBOX'
          ? items[index].asCheckboxItem()
          : type === 'PARAGRAPH_TEXT'
            ? items[index].asParagraphTextItem()
            : null;
    if (question && question.isRequired())
      throw new Error(
        'A completed question was made required. Restore optional before resuming; nothing was overwritten.',
      );
  }
  if (state.pending && state.pending.index !== completed)
    throw new Error('Saved item checkpoint is inconsistent. Do not clear ScriptProperties.');
}

function terminologyFormAdd_(form, type) {
  if (type === 'TEXT') return form.addTextItem();
  if (type === 'CHECKBOX') return form.addCheckboxItem();
  if (type === 'PARAGRAPH_TEXT') return form.addParagraphTextItem();
  if (type === 'SECTION_HEADER') return form.addSectionHeaderItem();
  if (type === 'PAGE_BREAK') return form.addPageBreakItem();
  throw new Error('Unknown questionnaire item type: ' + type);
}

function terminologyFormConfigureItem_(baseItem, definition, createdItemHere, knownPendingHere) {
  if (baseItem.getType() !== FormApp.ItemType[definition.type])
    throw new Error('Pending item has the wrong type. Nothing was overwritten.');
  var item = baseItem;
  if (definition.type === 'TEXT') item = baseItem.asTextItem();
  if (definition.type === 'CHECKBOX') item = baseItem.asCheckboxItem();
  if (definition.type === 'PARAGRAPH_TEXT') item = baseItem.asParagraphTextItem();
  if (definition.type === 'SECTION_HEADER') item = baseItem.asSectionHeaderItem();
  if (definition.type === 'PAGE_BREAK') item = baseItem.asPageBreakItem();
  // Service-provided defaults on an item added in this invocation are not owner edits.
  if (createdItemHere) {
    item.setTitle(definition.title);
    item.setHelpText(definition.help);
    if (definition.type === 'TEXT' || definition.type === 'CHECKBOX' || definition.type === 'PARAGRAPH_TEXT')
      item.setRequired(false);
    if (definition.type === 'CHECKBOX') {
      item.setChoiceValues(definition.choices);
      item.showOtherOption(false);
    }
    return;
  }
  var title = String(item.getTitle() || '');
  var help = String(item.getHelpText() || '');
  if ((title && title !== definition.title) || (help && help !== definition.help))
    throw new Error('Pending item was edited. Finish it manually; the script will not overwrite your wording.');
  var isQuestion = definition.type === 'TEXT' || definition.type === 'CHECKBOX' || definition.type === 'PARAGRAPH_TEXT';
  if (isQuestion && item.isRequired())
    throw new Error('A pending question was made required. Restore optional before resuming.');
  var choices;
  var normalizeChoices = false;
  if (definition.type === 'CHECKBOX') {
    // The generator owns choices only until this known pending item is checkpointed
    // complete. This also resumes older drafts without guessing localized defaults.
    normalizeChoices = knownPendingHere && title === definition.title && help === definition.help;
    choices = item.getChoices().map(function (choice) {
      return choice.getValue();
    });
    if (
      !normalizeChoices &&
      (item.hasOtherOption() || (choices.length && JSON.stringify(choices) !== JSON.stringify(definition.choices)))
    )
      throw new Error(
        'Unknown pending checkbox choices differ. Review the existing question; no choices were overwritten and its ID was not adopted.',
      );
  }
  // Validate every resumed field before making any changes or adopting an unknown ID.
  if (!title) item.setTitle(definition.title);
  if (!help) item.setHelpText(definition.help);
  if (isQuestion) item.setRequired(false);
  if (definition.type === 'CHECKBOX' && (normalizeChoices || !choices.length)) {
    item.setChoiceValues(definition.choices);
    item.showOtherOption(false);
    if (item.hasOtherOption())
      throw new Error('Could not disable the extra Other option. Rerun createTerminologyForm.');
  }
}

function terminologyFormReport_(form, complete) {
  var published = form.supportsAdvancedResponderPermissions() ? form.isPublished() : null;
  var result = {
    formId: form.getId(),
    creationComplete: complete,
    published: published,
    status: published ? 'PUBLISHED — RESPONDER ACCESS NOT VERIFIED' : 'UNPUBLISHED DRAFT — OWNER REVIEW REQUIRED',
    editUrl: form.getEditUrl(),
    respondentUrl: form.getPublishedUrl(),
    accessCheck:
      'In Google Forms, review privacy settings, publish for Anyone with the link if your account permits it, and test signed-out access before sharing.',
  };
  console.log(
    result.status +
      '\nEdit URL: ' +
      result.editUrl +
      '\nRespondent URL (draft until published): ' +
      result.respondentUrl +
      '\n' +
      result.accessCheck,
  );
  if (!complete) console.log('Partial draft saved. Run createTerminologyForm again in the same script project.');
  return result;
}
