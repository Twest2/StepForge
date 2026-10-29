'use strict';

const { isDeepStrictEqual } = require('node:util');
const { mergeValue } = require('./guide-merge');

/**
 * Renderer saves edit existing content. Step creation, deletion and ordering
 * have their own operations, and may have changed in the agent process since
 * the editor loaded its copy.
 */
function saveGuideFromEditor(store, guide) {
  if (!store.guideExists(guide.guideId)) throw new Error('This guide was moved to the Trash.');
  const current = store.getGuide(guide.guideId);
  return store.saveGuide({ ...guide, revision: current.revision, stepsOrder: current.stepsOrder });
}

function saveStepFromEditor(store, guideId, step, baseStep = null) {
  if (!store.guideExists(guideId)) throw new Error('This guide was moved to the Trash.');
  const guide = store.getGuide(guideId);
  if (!guide.stepsOrder.includes(step.stepId)) throw new Error('This step was deleted.');
  const current = store.getStep(guideId, step.stepId); // Refuse vanished files.
  // A dirty text edit must not undo an agent's move or the promotion of a
  // deleted parent's children. A fresh edit may still choose a new parent.
  const stale = step.revision !== current.revision;
  const imageChanged = !isDeepStrictEqual(step.image, current.image);
  if (stale && (!baseStep || baseStep.stepId !== step.stepId || baseStep.revision !== step.revision)) {
    throw new Error('This step changed outside the editor. Your unsaved edits are kept; reopen the guide after copying any text you want to keep.');
  }
  // Merge each field and each block/annotation by id against the copy the
  // editor loaded. Untouched local lists cannot resurrect deleted blocks or
  // erase annotations added by an agent. The user wins a same-field conflict.
  const content = stale ? mergeValue(baseStep, [step, current], { conflicts: 0 }) : step;
  // Screenshot operations have dedicated routes. A normal save cannot add
  // back a removed image, overwrite its dimensions, or restore its old kind.
  const fields = { ...content, image: current.image, kind: current.kind };
  if (stale) {
    fields.parentStepId = current.parentStepId;
    fields.redaction = current.redaction;
  }
  // Coordinates and privacy state belong to the current screenshot.
  if (imageChanged || !current.image) fields.annotations = current.annotations;
  return store.saveStep(guideId, { ...fields, revision: current.revision });
}

module.exports = { saveGuideFromEditor, saveStepFromEditor };
