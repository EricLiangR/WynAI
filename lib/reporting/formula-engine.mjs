const OPERATORS = new Set(['ratio', 'change', 'percentage', 'difference', 'sum']);

function number(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw Object.assign(new Error(`公式输入“${name}”不是有效数字`), { status: 422 });
  return numeric;
}

export function evaluateFormula(formula = {}, inputValues = {}) {
  if (formula.schema && formula.schema !== 'wynai.formula/v1') throw Object.assign(new Error('不支持的公式版本'), { status: 400 });
  if (!OPERATORS.has(formula.operator)) throw Object.assign(new Error(`公式操作不在白名单：${formula.operator}`), { status: 400 });
  const names = Array.isArray(formula.inputs) ? formula.inputs : [];
  const values = names.map(name => inputValues[name]);
  let result;
  if (formula.operator === 'sum') result = (Array.isArray(values[0]) ? values[0] : values).reduce((total, value) => total + number(value, names[0] || 'values'), 0);
  else if (formula.operator === 'difference') result = number(values[0], names[0]) - number(values[1], names[1]);
  else {
    const numerator = formula.operator === 'change' ? number(values[0], names[0]) - number(values[1], names[1]) : number(values[0], names[0]);
    const denominator = number(values[1], names[1]);
    if (denominator === 0) {
      if (formula.divideByZero === 'zero') result = 0;
      else if (formula.divideByZero === 'error') throw Object.assign(new Error('公式除数为零'), { status: 422 });
      else return { value: null, displayValue: '—', warning: '公式除数为零，结果为空', formulaVersion: 'wynai.formula/v1' };
    } else result = numerator / denominator;
  }
  result *= Number.isFinite(Number(formula.scale)) ? Number(formula.scale) : 1;
  const precision = Math.max(0, Math.min(8, Number(formula.precision) || 0));
  const rounded = Number(result.toFixed(precision));
  return { value: rounded, displayValue: rounded.toLocaleString('zh-CN', { minimumFractionDigits: precision, maximumFractionDigits: precision }), warning: null, formulaVersion: 'wynai.formula/v1' };
}

export const formulaOperators = Object.freeze([...OPERATORS]);
