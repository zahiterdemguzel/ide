'use strict';

// Quiet reporter for `node --test`: stays silent for passing tests and only
// prints failures, then a one-line summary. Keeps `npm test` output to the
// signal (what broke) instead of a wall of green TAP lines.
module.exports = async function* quietReporter(source) {
  let pass = 0;
  let fail = 0;
  let skip = 0;

  for await (const event of source) {
    switch (event.type) {
      case 'test:pass':
        // A suite reports pass/fail too; count only leaf tests so the summary
        // matches the number of individual cases.
        if (event.data.details?.type === 'suite') break;
        if (event.data.skip || event.data.todo) skip++;
        else pass++;
        break;

      case 'test:fail': {
        if (event.data.details?.type === 'suite') break;
        fail++;
        const { name, details } = event.data;
        const error = details?.error;
        yield `\n✖ ${name}\n`;
        const message = error?.cause?.stack || error?.stack || error?.message || String(error);
        yield `${String(message).replace(/^/gm, '    ')}\n`;
        break;
      }
    }
  }

  const summary = `${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`;
  yield fail ? `\n${summary}\n` : `${summary}\n`;
};
