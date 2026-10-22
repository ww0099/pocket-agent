import type { Tool } from './base.js';
import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { memoryTool } from './memory.js';
import { readTool } from './read.js';
import { skillTool } from './skill.js';
import { taskTool } from './task.js';
import { todoTool } from './todo.js';
import { writeTool } from './write.js';

export function createCoreTools(): Tool[] {
  return [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
    todoTool,
    memoryTool,
    skillTool,
    taskTool,
  ];
}
