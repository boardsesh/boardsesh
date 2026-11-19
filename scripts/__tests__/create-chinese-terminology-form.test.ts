/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('scripts/create-chinese-terminology-form.gs', 'utf8');
const stateKey = 'BOARDSESH_CHINESE_TERMINOLOGY_FORM_V1';
type ItemType = 'TEXT' | 'CHECKBOX' | 'PARAGRAPH_TEXT' | 'SECTION_HEADER' | 'PAGE_BREAK';
interface SavedState {
  formId: string | null;
  configured: boolean;
  itemIds: string[];
  pending: { index: number; id: string | null } | null;
  complete: boolean;
}
interface FormReport {
  creationComplete: boolean;
  published: boolean;
  status: string;
  editUrl: string;
  respondentUrl: string;
}

/** Concrete add* results intentionally have no generic Item.as* methods. */
class FormItem {
  title = '';
  help = '';
  required = false;
  choices: string[] = [];
  otherOption = false;
  constructor(
    readonly harness: Harness,
    readonly id: number,
    readonly type: ItemType,
  ) {}
  getId() {
    return this.id;
  }
  getType() {
    return this.type;
  }
  getTitle() {
    return this.title;
  }
  getHelpText() {
    return this.help;
  }
  isRequired() {
    return this.required;
  }
  getChoices() {
    return this.choices.map((choice) => ({ getValue: () => choice }));
  }
  hasOtherOption() {
    return this.otherOption;
  }
  showOtherOption(enabled: boolean) {
    this.harness.mutations++;
    this.otherOption = enabled;
    return this;
  }
  setTitle(title: string) {
    this.harness.mutations++;
    this.title = title;
    if (this.harness.failTitle && title.startsWith('Send｜')) {
      this.harness.failTitle = false;
      throw new Error('interrupted after setting title');
    }
    return this;
  }
  setHelpText(help: string) {
    this.harness.mutations++;
    this.help = help;
    return this;
  }
  setRequired(required: boolean) {
    this.harness.mutations++;
    this.required = required;
    return this;
  }
  setChoiceValues(choices: string[]) {
    if (this.harness.failCheckboxChoices) {
      this.harness.failCheckboxChoices = false;
      throw new Error('checkbox choice initialization failed');
    }
    this.harness.mutations++;
    this.choices = [...choices];
    return this;
  }
}

/** Form.getItems/getItemById return generic wrappers with casts, unlike add*. */
function genericItem(item: FormItem) {
  const cast = (type: ItemType) => {
    if (item.type !== type) throw new Error('invalid item cast');
    return item;
  };
  return {
    getId: () => item.id,
    getType: () => item.type,
    asTextItem: () => cast('TEXT'),
    asCheckboxItem: () => cast('CHECKBOX'),
    asParagraphTextItem: () => cast('PARAGRAPH_TEXT'),
    asSectionHeaderItem: () => cast('SECTION_HEADER'),
    asPageBreakItem: () => cast('PAGE_BREAK'),
  };
}

class FormDouble {
  readonly items: FormItem[] = [];
  readonly responses = ['existing response sentinel'];
  readonly settings: Record<string, boolean> = {};
  title: string;
  published = false;
  description = '';
  confirmation = '';
  constructor(
    readonly harness: Harness,
    title: string,
  ) {
    this.title = title;
  }
  getId() {
    return 'owned-draft-id';
  }
  getEditUrl() {
    return 'https://docs.google.com/forms/d/owned-draft-id/edit';
  }
  getPublishedUrl() {
    return 'https://docs.google.com/forms/d/e/owned-respondent-id/viewform';
  }
  getTitle() {
    return this.title;
  }
  setTitle(title: string) {
    if (this.harness.failFormTitle) {
      this.harness.failFormTitle = false;
      throw new Error('form title initialization failed');
    }
    this.harness.mutations++;
    this.harness.formTitleWrites.push(title);
    this.title = title;
    return this;
  }
  supportsAdvancedResponderPermissions() {
    return true;
  }
  isPublished() {
    return this.published;
  }
  getItems() {
    return this.items.map(genericItem);
  }
  getItemById(id: number) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw new Error('unknown item');
    return genericItem(item);
  }
  setPublished(published: boolean) {
    this.harness.mutations++;
    this.published = published;
    return this;
  }
  setCollectEmail(enabled: boolean) {
    return this.setting('email', enabled);
  }
  setLimitOneResponsePerUser(enabled: boolean) {
    return this.setting('oneResponse', enabled);
  }
  setPublishingSummary(enabled: boolean) {
    return this.setting('summary', enabled);
  }
  setIsQuiz(enabled: boolean) {
    return this.setting('quiz', enabled);
  }
  setShuffleQuestions(enabled: boolean) {
    return this.setting('shuffle', enabled);
  }
  setProgressBar(enabled: boolean) {
    return this.setting('progress', enabled);
  }
  collectsEmail() {
    return this.settings.email;
  }
  hasLimitOneResponsePerUser() {
    return this.settings.oneResponse;
  }
  isPublishingSummary() {
    return this.settings.summary;
  }
  isQuiz() {
    return this.settings.quiz;
  }
  getShuffleQuestions() {
    return this.settings.shuffle;
  }
  hasProgressBar() {
    return this.settings.progress;
  }
  setDescription(description: string) {
    this.harness.mutations++;
    this.description = description;
    return this;
  }
  setConfirmationMessage(confirmation: string) {
    this.harness.mutations++;
    this.confirmation = confirmation;
    return this;
  }
  private setting(name: string, enabled: boolean) {
    this.harness.mutations++;
    this.settings[name] = enabled;
    return this;
  }
  private add(type: ItemType) {
    if (type === 'PARAGRAPH_TEXT' && this.harness.failAddBefore) {
      this.harness.failAddBefore = false;
      throw new Error('add failed before mutation');
    }
    const item = new FormItem(this.harness, this.items.length + 1, type);
    item.title = this.harness.initialItemTitle;
    item.help = this.harness.initialItemHelp;
    item.required = this.harness.initialItemRequired;
    if (type === 'CHECKBOX') {
      item.choices = [...this.harness.initialCheckboxChoices];
      item.otherOption = this.harness.initialCheckboxOther;
    }
    this.items.push(item);
    this.harness.mutations++;
    if (type === 'PARAGRAPH_TEXT' && this.harness.failAddAfter) {
      this.harness.failAddAfter = false;
      throw new Error('add committed before timeout');
    }
    return item;
  }
  addTextItem() {
    return this.add('TEXT');
  }
  addCheckboxItem() {
    return this.add('CHECKBOX');
  }
  addParagraphTextItem() {
    return this.add('PARAGRAPH_TEXT');
  }
  addSectionHeaderItem() {
    return this.add('SECTION_HEADER');
  }
  addPageBreakItem() {
    return this.add('PAGE_BREAK');
  }
}

class Harness {
  readonly properties = new Map<string, string>();
  readonly logs: string[] = [];
  readonly formNames: string[] = [];
  readonly formTitleWrites: string[] = [];
  form?: FormDouble;
  initialVisibleTitle?: string;
  initialItemTitle = '';
  initialItemHelp = '';
  initialItemRequired = false;
  initialCheckboxChoices: string[] = [];
  initialCheckboxOther = false;
  creates = 0;
  mutations = 0;
  released = 0;
  locked = false;
  failTitle = false;
  failFormTitle = false;
  failCheckboxChoices = false;
  failAddBefore = false;
  failAddAfter = false;
  failSaveFormId = false;
  failSaveItemId = false;
  run(
    recoverId = '',
    entrypoint: 'createChineseTerminologyForm' | 'repairChineseTerminologyCheckbox' = 'createChineseTerminologyForm',
  ): FormReport {
    const code = source.replace(
      "var CHINESE_TERMINOLOGY_RECOVER_DRAFT_ID = '';",
      `var CHINESE_TERMINOLOGY_RECOVER_DRAFT_ID = ${JSON.stringify(recoverId)};`,
    );
    const context = {
      FormApp: {
        ItemType: Object.fromEntries(
          ['TEXT', 'CHECKBOX', 'PARAGRAPH_TEXT', 'SECTION_HEADER', 'PAGE_BREAK'].map((type) => [type, type]),
        ),
        create: (title: string, published: boolean) => {
          expect(published).toBe(false);
          this.creates++;
          this.formNames.push(title);
          this.form = new FormDouble(this, this.initialVisibleTitle ?? title);
          return this.form;
        },
        openById: (id: string) => {
          if (!this.form || id !== this.form.getId()) throw new Error('unknown form');
          return this.form;
        },
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (key: string) => this.properties.get(key) ?? null,
          setProperty: (key: string, contents: string) => {
            const state = JSON.parse(contents) as SavedState;
            if (this.failSaveFormId && state.formId) {
              this.failSaveFormId = false;
              throw new Error('draft ID checkpoint failed');
            }
            if (this.failSaveItemId && state.pending?.id && state.itemIds.length === 5) {
              this.failSaveItemId = false;
              throw new Error('item ID checkpoint failed');
            }
            this.properties.set(key, contents);
          },
        }),
      },
      LockService: {
        getScriptLock: () => ({
          tryLock: () => {
            if (this.locked) return false;
            this.locked = true;
            return true;
          },
          releaseLock: () => {
            this.released++;
            this.locked = false;
          },
        }),
      },
      console: { log: (message: string) => this.logs.push(message) },
    };
    runInNewContext(code, context);
    return (context as unknown as Record<typeof entrypoint, () => FormReport>)[entrypoint]();
  }
  questions() {
    return this.form!.items.filter((item) => ['TEXT', 'CHECKBOX', 'PARAGRAPH_TEXT'].includes(item.type));
  }
}

describe('Chinese terminology Google Form creation artifact (stand-in, not live Google proof)', () => {
  function pendingCheckboxDraft() {
    const harness = new Harness();
    harness.initialCheckboxChoices = ['Option 1'];
    harness.failCheckboxChoices = true;
    expect(() => harness.run()).toThrow('checkbox choice initialization failed');
    const checkbox = harness.questions().find((item) => item.type === 'CHECKBOX')!;
    return { harness, checkbox };
  }

  it('repairs the existing pending checkbox and releases its lock before resuming the same form', () => {
    const { harness, checkbox } = pendingCheckboxDraft();
    const checkboxId = checkbox.id;
    harness.questions()[0].title = 'Keep earlier owner wording';
    expect(() => harness.run()).toThrow('Pending checkbox choices differ');
    expect(checkbox.choices).toEqual(['Option 1']);
    const releases = harness.released;
    expect(harness.run('owned-draft-id', 'repairChineseTerminologyCheckbox').creationComplete).toBe(true);
    expect(harness.released - releases).toBe(2);
    expect(harness.locked).toBe(false);
    expect(harness.creates).toBe(1);
    expect(harness.questions()).toHaveLength(32);
    expect(harness.questions()[0].title).toBe('Keep earlier owner wording');
    expect(harness.questions().find((item) => item.type === 'CHECKBOX')!.id).toBe(checkboxId);
    expect(checkbox.choices).toEqual(['Kilter Board', 'Tension Board', 'MoonBoard', '喷点墙 / Spraywall', '其他']);
  });

  it('requires explicit repair for a built-in Other option even when all five literal choices match', () => {
    const { harness, checkbox } = pendingCheckboxDraft();
    checkbox.choices = ['Kilter Board', 'Tension Board', 'MoonBoard', '喷点墙 / Spraywall', '其他'];
    checkbox.otherOption = true;
    expect(() => harness.run()).toThrow('extra Other option');
    expect(checkbox.choices).toEqual(['Kilter Board', 'Tension Board', 'MoonBoard', '喷点墙 / Spraywall', '其他']);
    expect(checkbox.hasOtherOption()).toBe(true);
    expect(harness.run('owned-draft-id', 'repairChineseTerminologyCheckbox').creationComplete).toBe(true);
    expect(checkbox.hasOtherOption()).toBe(false);
    expect(harness.questions()).toHaveLength(32);
    expect(harness.creates).toBe(1);
  });

  it.each(['', 'another-form-id'])('rejects repair with missing or different recovery ID %j without writes', (id) => {
    const { harness, checkbox } = pendingCheckboxDraft();
    const checkpoint = harness.properties.get(stateKey);
    const mutations = harness.mutations;
    expect(() => harness.run(id, 'repairChineseTerminologyCheckbox')).toThrow('saved draft ID');
    expect(harness.properties.get(stateKey)).toBe(checkpoint);
    expect(harness.mutations).toBe(mutations);
    expect(checkbox.choices).toEqual(['Option 1']);
    expect(harness.creates).toBe(1);
  });

  it.each(['published', 'pending-id', 'pending-index', 'title', 'help', 'required'] as const)(
    'refuses %s draft changes before any checkbox repair writes',
    (change) => {
      const { harness, checkbox } = pendingCheckboxDraft();
      if (change === 'published') harness.form!.published = true;
      if (change === 'title') checkbox.title = 'Owner-edited checkbox';
      if (change === 'help') checkbox.help = 'Owner-edited help';
      if (change === 'required') checkbox.required = true;
      if (change === 'pending-id' || change === 'pending-index') {
        const state = JSON.parse(harness.properties.get(stateKey)!) as SavedState;
        if (change === 'pending-id') state.pending!.id = 'different-item-id';
        else state.pending!.index++;
        harness.properties.set(stateKey, JSON.stringify(state));
      }
      const checkpoint = harness.properties.get(stateKey);
      const mutations = harness.mutations;
      expect(() => harness.run('owned-draft-id', 'repairChineseTerminologyCheckbox')).toThrow();
      expect(harness.mutations).toBe(mutations);
      expect(harness.properties.get(stateKey)).toBe(checkpoint);
      expect(checkbox.choices).toEqual(['Option 1']);
      expect(harness.creates).toBe(1);
    },
  );

  it('does not create a form when repair has no saved checkpoint', () => {
    const harness = new Harness();
    expect(() => harness.run('owned-draft-id', 'repairChineseTerminologyCheckbox')).toThrow('No saved draft');
    expect(harness.mutations).toBe(0);
    expect(harness.creates).toBe(0);
    expect(harness.properties.size).toBe(0);
  });

  it('completed repair reruns require the exact ID and preserve published owner edits without writes', () => {
    const harness = new Harness();
    harness.run();
    harness.form!.title = 'Owner-edited form';
    harness.form!.published = true;
    const checkbox = harness.questions().find((item) => item.type === 'CHECKBOX')!;
    checkbox.choices = ['Owner choice'];
    checkbox.otherOption = true;
    const checkpoint = harness.properties.get(stateKey);
    const mutations = harness.mutations;
    expect(() => harness.run('', 'repairChineseTerminologyCheckbox')).toThrow('saved draft ID');
    expect(harness.run('owned-draft-id', 'repairChineseTerminologyCheckbox')).toMatchObject({
      creationComplete: true,
      published: true,
    });
    expect(harness.mutations).toBe(mutations);
    expect(harness.properties.get(stateKey)).toBe(checkpoint);
    expect(checkbox.choices).toEqual(['Owner choice']);
    expect(checkbox.hasOtherOption()).toBe(true);
    expect(harness.form!.responses).toEqual(['existing response sentinel']);
    expect(harness.creates).toBe(1);
  });

  it('initializes fresh item fields despite arbitrary service-provided initial defaults', () => {
    const harness = new Harness();
    harness.initialItemTitle = 'arbitrary initial title';
    harness.initialItemHelp = 'arbitrary initial help';
    harness.initialItemRequired = true;
    harness.initialCheckboxChoices = ['arbitrary initial option', 'another initial option'];
    harness.initialCheckboxOther = true;
    expect(harness.run().creationComplete).toBe(true);
    expect(harness.questions().find((item) => item.type === 'CHECKBOX')!.choices).toEqual([
      'Kilter Board',
      'Tension Board',
      'MoonBoard',
      '喷点墙 / Spraywall',
      '其他',
    ]);
    expect(harness.questions()).toHaveLength(32);
    expect(
      harness
        .questions()
        .find((item) => item.type === 'CHECKBOX')!
        .hasOtherOption(),
    ).toBe(false);
    expect(harness.questions().every((item) => !item.required)).toBe(true);
    expect(harness.form!.items.every((item) => item.title !== harness.initialItemTitle)).toBe(true);
    expect(harness.form!.items.every((item) => item.help !== harness.initialItemHelp)).toBe(true);
  });

  it('preserves mismatched pending checkbox choices and resumes after exact manual recovery', () => {
    const harness = new Harness();
    harness.initialCheckboxChoices = ['Option 1'];
    harness.failCheckboxChoices = true;
    expect(() => harness.run()).toThrow('checkbox choice initialization failed');
    const checkbox = harness.questions().find((item) => item.type === 'CHECKBOX')!;
    expect((JSON.parse(harness.properties.get(stateKey)!) as SavedState).pending?.id).toBe(String(checkbox.id));
    const count = harness.form!.items.length;
    expect(() => harness.run()).toThrow('Pending checkbox choices differ');
    expect(checkbox.choices).toEqual(['Option 1']);
    expect(harness.form!.items).toHaveLength(count);
    checkbox.choices = ['Owner-edited option'];
    expect(() => harness.run()).toThrow('No choices were overwritten');
    expect(checkbox.choices).toEqual(['Owner-edited option']);
    checkbox.setChoiceValues(['Kilter Board', 'Tension Board', 'MoonBoard', '喷点墙 / Spraywall', '其他']);
    expect(harness.run().creationComplete).toBe(true);
    expect(harness.questions()).toHaveLength(32);
    expect(harness.form!.items.find((item) => item.type === 'CHECKBOX')!.id).toBe(checkbox.id);
    expect(harness.creates).toBe(1);
  });

  it('explicitly initializes a new draft title when create returns a different visible title', () => {
    const harness = new Harness();
    harness.initialVisibleTitle = 'Untitled form';
    expect(harness.run().creationComplete).toBe(true);
    expect(harness.formNames).toEqual(['帮 Boardsesh 说好攀岩中文']);
    expect(harness.formTitleWrites).toEqual(['帮 Boardsesh 说好攀岩中文']);
    expect(harness.form!.getTitle()).toBe('帮 Boardsesh 说好攀岩中文');
    expect(harness.questions()).toHaveLength(32);
    expect(harness.form!.published).toBe(false);
  });

  it('recovers an empty saved draft title only with its explicit matching recovery ID', () => {
    const harness = new Harness();
    harness.initialVisibleTitle = 'Untitled form';
    harness.failFormTitle = true;
    expect(() => harness.run()).toThrow('form title initialization failed');
    const checkpoint = harness.properties.get(stateKey);
    expect(JSON.parse(checkpoint!) as SavedState).toMatchObject({
      formId: 'owned-draft-id',
      configured: false,
      itemIds: [],
      pending: null,
      complete: false,
    });
    const mutations = harness.mutations;
    expect(() => harness.run()).toThrow('actual "Untitled form"; expected "帮 Boardsesh 说好攀岩中文"');
    expect(() => harness.run('another-form-id')).toThrow('Draft title mismatch');
    expect(harness.properties.get(stateKey)).toBe(checkpoint);
    expect(harness.mutations).toBe(mutations);
    expect(harness.formTitleWrites).toEqual([]);
    expect(harness.run('owned-draft-id').creationComplete).toBe(true);
    expect(harness.creates).toBe(1);
    expect(harness.form!.getId()).toBe('owned-draft-id');
    expect(harness.formTitleWrites).toEqual(['帮 Boardsesh 说好攀岩中文']);
    expect(harness.questions()).toHaveLength(32);
  });

  it('refuses explicit title recovery after the owner renames a partially configured draft', () => {
    const harness = new Harness();
    harness.failTitle = true;
    expect(() => harness.run()).toThrow();
    harness.form!.title = 'Owner-renamed draft';
    const checkpoint = harness.properties.get(stateKey);
    const mutations = harness.mutations;
    expect(() => harness.run('owned-draft-id')).toThrow('actual "Owner-renamed draft"');
    expect(harness.form!.getTitle()).toBe('Owner-renamed draft');
    expect(harness.mutations).toBe(mutations);
    expect(harness.properties.get(stateKey)).toBe(checkpoint);
    expect(harness.formTitleWrites).toEqual(['帮 Boardsesh 说好攀岩中文']);
  });

  it('does not recover the title of a published or nonempty saved draft', () => {
    const harness = new Harness();
    harness.initialVisibleTitle = 'Untitled form';
    harness.failFormTitle = true;
    expect(() => harness.run()).toThrow('form title initialization failed');
    harness.form!.published = true;
    let mutations = harness.mutations;
    expect(() => harness.run('owned-draft-id')).toThrow('Resume only an unpublished draft');
    expect(harness.mutations).toBe(mutations);
    harness.form!.published = false;
    harness.form!.addTextItem().setTitle('Owner-added question');
    mutations = harness.mutations;
    expect(() => harness.run('owned-draft-id')).toThrow('Draft title mismatch');
    expect(harness.mutations).toBe(mutations);
    expect(harness.formTitleWrites).toEqual([]);
    expect(harness.form!.items).toHaveLength(1);
  });

  it('creates one unpublished draft with five sections and all 32 optional questions', () => {
    const harness = new Harness();
    const report = harness.run();
    expect(harness.creates).toBe(1);
    expect(report).toMatchObject({ creationComplete: true, published: false });
    expect(report.status).toContain('UNPUBLISHED DRAFT');
    expect(harness.form!.settings).toEqual({
      email: false,
      oneResponse: false,
      summary: false,
      quiz: false,
      shuffle: false,
      progress: true,
    });
    const questions = harness.questions();
    expect(questions).toHaveLength(32);
    expect(questions.every((item) => !item.required)).toBe(true);
    expect(questions.filter((item) => item.type === 'PARAGRAPH_TEXT')).toHaveLength(29);
    expect(questions.filter((item) => item.type === 'TEXT')).toHaveLength(2);
    expect(questions.find((item) => item.type === 'CHECKBOX')!.choices).toEqual([
      'Kilter Board',
      'Tension Board',
      'MoonBoard',
      '喷点墙 / Spraywall',
      '其他',
    ]);
    expect(harness.form!.items.filter((item) => item.type === 'SECTION_HEADER')).toHaveLength(1);
    expect(harness.form!.items.filter((item) => item.type === 'PAGE_BREAK')).toHaveLength(4);
    expect(questions.filter((item) => item.title.includes('｜')).map((item) => item.title.split('｜')[0])).toEqual([
      'Send',
      'Flash',
      'Redpoint',
      'Repeat',
      'Beta',
      'Project / projecting',
      'Tick / logbook',
      'Session',
      'Crew',
      'Climb / boulder problem',
      'Benchmark',
      'Consensus grade',
      'Tall climbs',
      'Set angle',
      'Route / circuit',
      'Playlist',
      'Hold',
      'Crimp',
      'Campus',
      'Matching',
      'Board',
      'Spraywall',
      'Kickboard / kicker',
      'Volume',
      'Kiosk',
      'Drive the wall',
      'Set screw',
      'T-nut',
    ]);
    expect(harness.form!.description).toContain('AI');
    expect(harness.form!.description).toContain('完全自愿');
    expect(harness.form!.description).toContain('请勿填写姓名、邮箱');
  });

  it('retains the reviewed definitions and matches the saved questionnaire titles', () => {
    const harness = new Harness();
    harness.run();
    const questions = harness.questions();
    expect(questions.find((item) => item.title.startsWith('Flash｜'))!.help).toContain('可以看过别人爬');
    expect(questions.find((item) => item.title.startsWith('Route / circuit｜'))!.help).toContain('训练线路组');
    expect(questions.find((item) => item.title.startsWith('Tall climbs｜'))!.help).toContain('不要求用到最顶排');
    expect(questions.find((item) => item.title.startsWith('Matching｜'))!.help).not.toContain('同点换手');
    const document = readFileSync('docs/i18n-chinese-glossary.md', 'utf8');
    for (const question of questions) expect(document, question.title).toContain(question.title);
  });

  it('completed reruns preserve owner edits, responses and publication state with no writes', () => {
    const harness = new Harness();
    harness.run();
    harness.questions()[0].title = 'Owner-edited question';
    harness.form!.title = 'Owner-edited form';
    harness.form!.published = true;
    const mutations = harness.mutations;
    const saved = harness.properties.get(stateKey);
    expect(harness.run()).toMatchObject({ creationComplete: true, published: true });
    expect(harness.mutations).toBe(mutations);
    expect(harness.properties.get(stateKey)).toBe(saved);
    expect(harness.form!.responses).toEqual(['existing response sentinel']);
    expect(harness.questions()[0].title).toBe('Owner-edited question');
    expect(harness.creates).toBe(1);
  });

  it.each(['failTitle', 'failAddAfter', 'failSaveItemId'] as const)(
    'resumes %s interruptions without duplicate questions',
    (failure) => {
      const harness = new Harness();
      harness[failure] = true;
      expect(() => harness.run()).toThrow();
      expect(harness.released).toBe(1);
      harness.questions()[0].title = 'Keep this earlier owner edit';
      expect(harness.run().creationComplete).toBe(true);
      expect(harness.questions()).toHaveLength(32);
      expect(harness.form!.items).toHaveLength(37);
      expect(harness.questions()[0].title).toBe('Keep this earlier owner edit');
      expect(harness.creates).toBe(1);
    },
  );

  it('never blindly repeats an uncertain add; an owner can supply the missing blank item', () => {
    const harness = new Harness();
    harness.failAddBefore = true;
    expect(() => harness.run()).toThrow('before mutation');
    const count = harness.form!.items.length;
    expect(() => harness.run()).toThrow('uncertain result');
    expect(harness.form!.items).toHaveLength(count);
    harness.form!.addParagraphTextItem();
    expect(harness.run().creationComplete).toBe(true);
    expect(harness.questions()).toHaveLength(32);
  });

  it('recovers the create/checkpoint gap only through a matching empty unpublished draft ID', () => {
    const harness = new Harness();
    harness.failSaveFormId = true;
    expect(() => harness.run()).toThrow('draft ID checkpoint failed');
    expect(() => harness.run()).toThrow('Creation outcome is uncertain');
    expect(harness.creates).toBe(1);
    expect(harness.logs.join('\n')).toContain('RECOVERY draft ID: owned-draft-id');
    harness.form!.published = true;
    expect(() => harness.run('owned-draft-id')).toThrow('EMPTY, UNPUBLISHED');
    harness.form!.published = false;
    expect(harness.run('owned-draft-id').creationComplete).toBe(true);
    expect(harness.questions()).toHaveLength(32);
    expect(harness.creates).toBe(1);
  });

  it('does not overwrite a pending item that an owner edited', () => {
    const harness = new Harness();
    harness.failTitle = true;
    expect(() => harness.run()).toThrow();
    harness.form!.items.at(-1)!.title = 'Owner replacement wording';
    const count = harness.form!.items.length;
    const mutations = harness.mutations;
    expect(() => harness.run()).toThrow('will not overwrite');
    expect(harness.form!.items.at(-1)!.title).toBe('Owner replacement wording');
    expect(harness.form!.items).toHaveLength(count);
    expect(harness.mutations).toBe(mutations);
  });

  it('will not complete a partial draft after an earlier question was made required', () => {
    const harness = new Harness();
    harness.failTitle = true;
    expect(() => harness.run()).toThrow();
    harness.questions()[0].required = true;
    const count = harness.form!.items.length;
    const mutations = harness.mutations;
    expect(() => harness.run()).toThrow('completed question was made required');
    expect(harness.mutations).toBe(mutations);
    expect(harness.form!.items).toHaveLength(count);
    expect((JSON.parse(harness.properties.get(stateKey)!) as SavedState).complete).toBe(false);
  });

  it('refuses untracked owner additions instead of deleting or duplicating them', () => {
    const harness = new Harness();
    harness.failTitle = true;
    expect(() => harness.run()).toThrow();
    harness.form!.addTextItem().setTitle('Owner-added extra');
    const count = harness.form!.items.length;
    expect(() => harness.run()).toThrow('added or removed');
    expect(harness.form!.items).toHaveLength(count);
    expect(harness.form!.items.at(-1)!.title).toBe('Owner-added extra');
  });

  it('a competing script execution cannot create or mutate a draft', () => {
    const harness = new Harness();
    harness.locked = true;
    expect(() => harness.run()).toThrow('Another creation is running');
    expect(harness.creates).toBe(0);
    expect(harness.properties.size).toBe(0);
    expect(harness.released).toBe(0);
  });
});
