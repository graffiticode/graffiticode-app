import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPromptLanguage } from '@graffiticode-app/core/lib/prompt-language';

// Fixtures are synthetic but shaped like the production prompts the gate caught in shadow mode (Oct 2026):
// an English instruction whose quoted non-Latin content outweighs it letter for letter.

const HAN_CONTENT_IN_ENGLISH =
  'Create a clean worldbuilding board titled "十三魔族优化设定" with a dark theme. Each card should contain ' +
  'these fields in Chinese: 人类伪装，魔族真身，标志特征，能力描述，弱点与禁忌，所属家族，历史背景，' +
  '与主角的关系，最终结局，外形设定，武器与道具，口头禅，代表颜色，出场章节，命运转折，隐藏秘密。' +
  '图例写着“核心遵循官方设定；年代状态为基于原作时间线的合理整理”。';

const ARABIC_CONTENT_IN_ENGLISH =
  'Create a polished concept web with "منظومة الذكاء الاصطناعي الهجينة" as the central hub. Add these nodes: ' +
  '"واجهة المستخدم والمحادثة والمهام والموافقات"، "الخلفية وواجهات البرمجة والخدمات المصغرة"، ' +
  '"قاعدة البيانات والذاكرة طويلة المدى"، "الأمان والصلاحيات وسجل التدقيق والمراقبة المستمرة".';

const HAN_INSTRUCTION =
  '请创建一个简洁、可复制编辑的中文报销单表格：白底、黑色边框。表格7列依次为：姓名、工号、时间、金额（元）、' +
  '种类、发票类型、备注。在最后增加总计行，在金额列用SUM公式汇总上面4条金额。';

const ARABIC_INSTRUCTION =
  'أنشئ جدول مهام يومي بسيطًا وقابلًا للتعديل بالعربية. عنوانه «مهام اليوم». أربعة أعمدة فقط: المهمة، المدة، الأولوية، الحالة.';

test('an English instruction carrying heavy Han content is english, not refused', () => {
  const r = classifyPromptLanguage(HAN_CONTENT_IN_ENGLISH);
  assert.ok(r.latinRatio < 0.5, `fixture must sit below the Latin floor to exercise the override (got ${r.latinRatio})`);
  assert.equal(r.verdict, 'english');
});

test('an English instruction carrying heavy Arabic content is english, not refused', () => {
  const r = classifyPromptLanguage(ARABIC_CONTENT_IN_ENGLISH);
  assert.ok(r.latinRatio < 0.5, `fixture must sit below the Latin floor to exercise the override (got ${r.latinRatio})`);
  assert.equal(r.verdict, 'english');
});

test('a Chinese instruction is still non_english, even with a Latin token like SUM in it', () => {
  const r = classifyPromptLanguage(HAN_INSTRUCTION);
  assert.equal(r.verdict, 'non_english');
  assert.equal(r.script, 'han');
});

test('an Arabic instruction is still non_english', () => {
  const r = classifyPromptLanguage(ARABIC_INSTRUCTION);
  assert.equal(r.verdict, 'non_english');
  assert.equal(r.script, 'arabic');
});

test('one or two stray English words do not overrule a non-Latin instruction', () => {
  const r = classifyPromptLanguage('创建一个关于分数的五年级数学测验，标题是 the quiz，包含十道选择题和答案解析');
  assert.ok(r.englishMarkers < 3);
  assert.equal(r.verdict, 'non_english');
});

test('existing cases keep their verdicts', () => {
  const nonEnglish = [
    'Создай тест по математике для 5 класса про дроби',
    'Créez un quiz de mathématiques pour la cinquième année',
    'Erstelle eine Tabelle mit den Ausgaben für das Jahr',
    'Crea una hoja de cálculo para los gastos del mes',
    '分数に関する5年生の数学クイズを作成してください',
  ];
  for (const text of nonEnglish) assert.equal(classifyPromptLanguage(text).verdict, 'non_english', text);

  const proceed = [
    'Create flashcards for Russian vocabulary: кот = cat, дом = house',
    'Make a quiz about Chinese characters: 水 means water, 火 means fire',
    'Bar chart, quarterly revenue 2024',
    'Change the café name to Müller\'s and update the sign',
    'quiz',
  ];
  for (const text of proceed) assert.notEqual(classifyPromptLanguage(text).verdict, 'non_english', text);
});
