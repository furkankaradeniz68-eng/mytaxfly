const isAmount = v => {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
};

// The standard PDF fonts only cover WinAnsi and throw on anything else, e.g. "Ş" or "ł".
export function toPdfText(value) {
  const extra = { 'ı':'i', 'İ':'I', 'ł':'l', 'Ł':'L', 'đ':'d', 'Đ':'D', 'ħ':'h', 'Ħ':'H' };
  return String(value).replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF€–—‘’“”•…]/g, ch => {
    const plain = extra[ch] ?? ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return /^[\x20-\x7E]+$/.test(plain) ? plain : '?';
  });
}

const countQuestionMarks = s => (s.match(/\?/g) || []).length;

function findNonLatinPath(value, path) {
  if (typeof value === 'string') {
    return countQuestionMarks(toPdfText(value)) > countQuestionMarks(value) ? path : null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const found = findNonLatinPath(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

// Returns the first problem as a message, or null when the payload is valid.
export function validateFilingNumbers({ form_type, tax_year, company, foreign_owner, transactions, partners, financials, signer_name }) {
  const nonLatinPath = findNonLatinPath({ company, foreign_owner, partners, signer_name }, 'body');
  if (nonLatinPath) return `${nonLatinPath.replace('body.', '')} must use Latin letters. IRS forms cannot show this text.`;

  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(tax_year) || tax_year < 2000 || tax_year > maxYear) {
    return `tax_year must be a four-digit year between 2000 and ${maxYear}.`;
  }
  // "Applied for" is what the IRS instructs filers to enter while an EIN is pending.
  if (typeof company.ein !== 'string' || !/^(\d{2}-?\d{7}|applied for)$/i.test(company.ein.trim())) {
    return 'company.ein must look like "12-3456789" (or "Applied for" while the EIN is pending).';
  }
  if (company.total_assets != null && !isAmount(company.total_assets)) {
    return 'company.total_assets must be a number.';
  }
  if (company.initial_return != null && typeof company.initial_return !== 'boolean') {
    return 'company.initial_return must be true or false.';
  }
  if (company.incorporated_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(company.incorporated_date))) {
    return 'company.incorporated_date must use the format YYYY-MM-DD.';
  }

  for (const [i, tx] of (Array.isArray(transactions) ? transactions : []).entries()) {
    for (const field of ['amount', 'amount_beginning', 'amount_ending']) {
      if (tx?.[field] != null && !isAmount(tx[field])) return `transactions[${i}].${field} must be a number.`;
    }
  }

  if (financials?.gross_revenue != null && !isAmount(financials.gross_revenue)) {
    return 'financials.gross_revenue must be a number.';
  }
  for (const [key, value] of Object.entries(financials?.expenses || {})) {
    if (value != null && !isAmount(value)) return `financials.expenses.${key} must be a number.`;
  }

  if (form_type === '1065') {
    let total = 0;
    for (const [i, pt] of partners.entries()) {
      const share = pt?.ownership_percent ?? pt?.profit_percent;
      if (!isAmount(share) || Number(share) <= 0 || Number(share) > 100) {
        return `partners[${i}].ownership_percent must be greater than 0 and at most 100.`;
      }
      total += Number(share);
      for (const field of ['capital_beginning', 'capital_contribution', 'distributions', 'distribution']) {
        if (pt[field] != null && !isAmount(pt[field])) return `partners[${i}].${field} must be a number.`;
      }
    }
    if (Math.abs(total - 100) > 0.01) return `Partner ownership must total 100% (received ${total}%).`;
  }

  return null;
}
