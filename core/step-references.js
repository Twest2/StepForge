'use strict';
// Copy/import changes step identities; order changes do not. Only references
// are remapped, never matching text inside code blocks or ordinary labels.
function remapStepReferences(step, ids) {
  for (const graph of [step.flowchart, ...(step.flowchartBlocks || []).map(b => b.graph)].filter(Boolean)) {
    for (const node of graph.nodes || []) if (node.stepId) node.stepId = ids.get(node.stepId) || node.stepId;
  }
  const html = text => String(text || '').replace(/href="step:([a-zA-Z0-9_-]+)"/g, (whole, id) => ids.has(id) ? `href="step:${ids.get(id)}"` : whole);
  step.descriptionHtml = html(step.descriptionHtml);
  for (const b of step.textBlocks || []) b.descriptionHtml = html(b.descriptionHtml);
  if (typeof step.descriptionMarkdown === 'string') step.descriptionMarkdown = step.descriptionMarkdown.replace(/(`+|~{3,})[\s\S]*?\1|(\[[^\]\n]*\]\()step:([a-zA-Z0-9_-]+)(\))|(^ {0,3}\[[^\]\n]+\]:[ \t]*<?)step:([a-zA-Z0-9_-]+)(>?)/gm,
    (whole, code, inline, inlineId, end, definition, definitionId, angle) => {
      const id = inlineId || definitionId;
      return code || !ids.has(id) ? whole : `${inline || definition}step:${ids.get(id)}${end || angle || ''}`;
    });
  for (const link of step.links || []) if (link.targetStepId) link.targetStepId = ids.get(link.targetStepId) || link.targetStepId;
  return step;
}
module.exports = { remapStepReferences };
