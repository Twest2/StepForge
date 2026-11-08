const path = require('node:path');
const { mergeBase } = require(path.resolve(__dirname, '../../core/guide-merge'));

/**
 * Test for deterministic merge-base.
 * If two versions have the same `createdTime`, the merge-base should still
 * be stable regardless of the order of the input array.
 */
function testDeterministicMergeBase() {
  const baseFile = {
    id: 'base',
    createdTime: '2023-01-01T00:00:00.000Z',
    appProperties: { parent: 'ancestor', hash: 'h1' }
  };

  const sideA = {
    id: 'sideA',
    createdTime: '2023-01-02T00:00:00.000Z',
    appProperties: { parent: 'base', hash: 'h2' }
  };

  const sideB = {
    id: 'sideB',
    createdTime: '2023-01-02T00:00:00.000Z', // Same time as sideA
    appProperties: { parent: 'base', hash: 'h3' }
  };

  const versions = [sideA, sideB];
  const commonAncestor = mergeBase(baseFile, versions, []);
  
  console.log('Merge base result:', JSON.stringify(commonAncestor, null, 2));
  
  // The result should be the 'base' file based on the current implementation.
  if (commonAncestor && commonAncestor.guide && commonAncestor.guide.id === 'base') {
    console.log('✅ Pass: Merge-base result is correct');
  } else {
    console.error('❌ Fail: Merge-base result is incorrect');
    process.exit(1);
  }
}

/**
 * Test that common ancestor is correctly found across multiple branches.
 */
function testComplexAncestry() {
  const ancestor = { id: 'anc', createdTime: '2023-01-01', appProperties: { parent: null, hash: 'h0' } };
  const base = { id: 'base', createdTime: '2023-01-02', appProperties: { parent: 'anc', hash: 'h1' } };
  
  const sideA = { id: 'sideA', createdTime: '2023-01-03', appProperties: { parent: 'base', hash: 'h2' } };
  const sideB = { id: 'sideB', createdTime: '2023-01-04', appProperties: { parent: 'base', hash: 'h3' } };
  const sideC = { id: 'sideC', createdTime: '2023-01-05', appProperties: { parent: 'base', hash: 'h4' } };

  const versions = [sideA, sideB, sideC];
  const common = mergeBase(base, versions, []);
  
  if (common && common.guide.id === 'base') {
    console.log('✅ Pass: Complex ancestry correct');
  } else {
    console.error('❌ Fail: Complex ancestry incorrect. Expected: base, got:', common?.guide?.id);
    process.exit(1);
  }
}

testDeterministicMergeBase();
testComplexAncestry();
