'use strict';

// Read-only parser for BugLoop's flat-file ledger format. Mirrors
// bugloop.sh's get_field/gate parsing logic in spirit, but this is for
// DISPLAY only -- it is never the source of truth for gate decisions, the
// engine (bugloop.sh) always is. A parse quirk here can make the dashboard
// show something oddly, never make bugloop.sh behave inconsistently.

const TITLE_RE = /^# Bug: (.+)$/;
const HEADING_RE = /^## (.+)$/;
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_.]*):[ \t]?(.*)$/;
const HYPOTHESIS_RE = /^- \[(\d+)\] status=(\w+) :: (.*?) :: (.*?) :: (.*)$/;
const RECEIPT_HEADER_RE = /^### (\S+) [—-] `(.*)` [—-] exit (-?\d+)$/;

function parseLedger(text) {
  const lines = text.split('\n');
  const fields = {};
  const hypotheses = [];
  const receipts = [];
  let title = '';

  let currentReceipt = null;
  let inFence = false;

  for (const line of lines) {
    if (currentReceipt) {
      if (line.trim() === '```') {
        if (!inFence) {
          inFence = true;
        } else {
          inFence = false;
          currentReceipt.output = currentReceipt.output.join('\n');
          currentReceipt = null;
        }
        continue;
      }
      if (inFence) {
        currentReceipt.output.push(line);
      }
      continue;
    }

    const titleMatch = TITLE_RE.exec(line);
    if (titleMatch) {
      title = titleMatch[1];
      continue;
    }

    if (HEADING_RE.test(line)) continue; // section headers are for humans only
    if (line.startsWith('<!--')) continue; // comment lines (incl. multi-line openers)

    const hypMatch = HYPOTHESIS_RE.exec(line);
    if (hypMatch) {
      hypotheses.push({
        n: parseInt(hypMatch[1], 10),
        status: hypMatch[2],
        statement: hypMatch[3],
        evidence: hypMatch[4],
        falsifier: hypMatch[5],
      });
      continue;
    }

    const receiptMatch = RECEIPT_HEADER_RE.exec(line);
    if (receiptMatch) {
      currentReceipt = {
        timestamp: receiptMatch[1],
        cmd: receiptMatch[2],
        exitCode: parseInt(receiptMatch[3], 10),
        output: [],
      };
      receipts.push(currentReceipt);
      continue;
    }

    const fieldMatch = FIELD_RE.exec(line);
    if (fieldMatch) {
      fields[fieldMatch[1]] = fieldMatch[2] || '';
    }
  }

  return { title, fields, hypotheses, receipts };
}

module.exports = { parseLedger };
