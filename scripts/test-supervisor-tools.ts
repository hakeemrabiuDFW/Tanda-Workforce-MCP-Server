// Quick test to verify supervisor optimization tools are registered
import { tandaTools } from '../src/mcp/tools';

console.log('\n=== Supervisor Scheduling Optimization Tools ===\n');

const supervisorTools = tandaTools.filter(t =>
  t.name.includes('supervisor') ||
  t.name.includes('optimized') ||
  t.name.includes('evening') ||
  t.name.includes('placement') ||
  t.name.includes('overlap')
);

console.log('Found ' + supervisorTools.length + ' supervisor optimization tools:\n');

for (let i = 0; i < supervisorTools.length; i++) {
  const tool = supervisorTools[i];
  console.log((i + 1) + '. ' + tool.name);
  console.log('   Description: ' + tool.description);
  console.log('   Required params: ' + (tool.inputSchema.required?.join(', ') || 'none'));
  console.log('');
}

console.log('\n=== Total Tools Summary ===');
console.log('Total tools available: ' + tandaTools.length);
console.log('Supervisor tools: ' + supervisorTools.length);
