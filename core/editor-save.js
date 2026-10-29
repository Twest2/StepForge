'use strict';

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

function saveStepFromEditor(store, guideId, step) {
  if (!store.guideExists(guideId)) throw new Error('This guide was moved to the Trash.');
  const guide = store.getGuide(guideId);
  if (!guide.stepsOrder.includes(step.stepId)) throw new Error('This step was deleted.');
  const current = store.getStep(guideId, step.stepId); // Refuse vanished files.
  // A dirty text edit must not undo an agent's move or the promotion of a
  // deleted parent's children. A fresh edit may still choose a new parent.
  const fields = step.revision !== current.revision
    ? { ...step, parentStepId: current.parentStepId } : step;
  return store.saveStep(guideId, { ...fields, revision: current.revision });
}

module.exports = { saveGuideFromEditor, saveStepFromEditor };
