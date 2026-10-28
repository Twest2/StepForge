'use strict';

/** Both the original dispatch and a later rerun must come from the owner. */
function checkReleaseAccess(env = process.env) {
  const owner = env.GITHUB_REPOSITORY_OWNER;
  const actor = env.GITHUB_ACTOR;
  const triggeringActor = env.GITHUB_TRIGGERING_ACTOR;
  if (!owner || !actor || !triggeringActor
      || actor.toLowerCase() !== owner.toLowerCase()
      || triggeringActor.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('Only the repository owner can start or rerun a StepForge release.');
  }
}

if (require.main === module) {
  try {
    checkReleaseAccess();
    console.log('Release authorized for the repository owner.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { checkReleaseAccess };
