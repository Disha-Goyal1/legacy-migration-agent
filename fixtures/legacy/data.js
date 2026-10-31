const profile = { name: "Disha", active: true };
const scores = [2, 3, 5];

function summarize() {
  return { profile, scores };
}

module.exports = { profile, scores, summarize };
