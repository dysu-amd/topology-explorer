/*
 * Minimal TOML parser for BUILD_TOPOLOGY.toml.
 *
 * The topology uses tables, quoted strings, scalars, arrays, and inline tables.
 * Keeping this parser local lets the static site load the live topology without
 * a CDN dependency or a server-side conversion step.
 */
(() => {
  "use strict";

  function stripComment(line) {
    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && character === "\\") {
        escaped = true;
        continue;
      }
      if (!quote && (character === '"' || character === "'")) {
        quote = character;
        continue;
      }
      if (quote === character) {
        quote = null;
        continue;
      }
      if (!quote && character === "#") {
        return line.slice(0, index);
      }
    }
    return line;
  }

  function scanTopLevel(value, separator) {
    const positions = [];
    let quote = null;
    let escaped = false;
    let bracketDepth = 0;
    let braceDepth = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && character === "\\") {
        escaped = true;
        continue;
      }
      if (!quote && (character === '"' || character === "'")) {
        quote = character;
        continue;
      }
      if (quote === character) {
        quote = null;
        continue;
      }
      if (quote) {
        continue;
      }
      if (character === "[") {
        bracketDepth += 1;
      } else if (character === "]") {
        bracketDepth -= 1;
      } else if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth -= 1;
      } else if (
        character === separator &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        positions.push(index);
      }
    }
    return positions;
  }

  function isCompleteValue(value) {
    let quote = null;
    let escaped = false;
    let bracketDepth = 0;
    let braceDepth = 0;
    for (const character of value) {
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && character === "\\") {
        escaped = true;
        continue;
      }
      if (!quote && (character === '"' || character === "'")) {
        quote = character;
      } else if (quote === character) {
        quote = null;
      } else if (!quote && character === "[") {
        bracketDepth += 1;
      } else if (!quote && character === "]") {
        bracketDepth -= 1;
      } else if (!quote && character === "{") {
        braceDepth += 1;
      } else if (!quote && character === "}") {
        braceDepth -= 1;
      }
    }
    return !quote && bracketDepth === 0 && braceDepth === 0;
  }

  function splitTopLevel(value, separator) {
    const separators = scanTopLevel(value, separator);
    const pieces = [];
    let start = 0;
    for (const index of separators) {
      pieces.push(value.slice(start, index).trim());
      start = index + 1;
    }
    const finalPiece = value.slice(start).trim();
    if (finalPiece) {
      pieces.push(finalPiece);
    }
    return pieces;
  }

  function splitAssignment(value) {
    const positions = scanTopLevel(value, "=");
    if (positions.length === 0) {
      throw new Error(`Expected a TOML assignment: ${value}`);
    }
    const index = positions[0];
    return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
  }

  function parseValue(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('"')) {
      return JSON.parse(trimmed);
    }
    if (trimmed.startsWith("'")) {
      if (!trimmed.endsWith("'")) {
        throw new Error(`Unterminated literal string: ${trimmed}`);
      }
      return trimmed.slice(1, -1);
    }
    if (trimmed.startsWith("[")) {
      if (!trimmed.endsWith("]")) {
        throw new Error(`Unterminated array: ${trimmed}`);
      }
      const contents = trimmed.slice(1, -1).trim();
      return contents ? splitTopLevel(contents, ",").map(parseValue) : [];
    }
    if (trimmed.startsWith("{")) {
      if (!trimmed.endsWith("}")) {
        throw new Error(`Unterminated inline table: ${trimmed}`);
      }
      const contents = trimmed.slice(1, -1).trim();
      const table = {};
      if (!contents) {
        return table;
      }
      for (const entry of splitTopLevel(contents, ",")) {
        const [key, entryValue] = splitAssignment(entry);
        table[key] = parseValue(entryValue);
      }
      return table;
    }
    if (trimmed === "true") {
      return true;
    }
    if (trimmed === "false") {
      return false;
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    throw new Error(`Unsupported TOML value: ${trimmed}`);
  }

  function setValue(target, key, value) {
    const keyPath = key.split(".");
    const finalKey = keyPath.pop();
    let table = target;
    for (const part of keyPath) {
      table[part] ??= {};
      table = table[part];
    }
    table[finalKey] = value;
  }

  function getTable(target, path) {
    let table = target;
    for (const part of path.split(".")) {
      table[part] ??= {};
      table = table[part];
    }
    return table;
  }

  function parseTopologyToml(source) {
    const result = {};
    let table = result;
    let assignment = "";

    const finishAssignment = () => {
      const [key, value] = splitAssignment(assignment);
      setValue(table, key, parseValue(value));
      assignment = "";
    };

    for (const rawLine of source.split(/\r?\n/)) {
      const line = stripComment(rawLine).trim();
      if (!line) {
        continue;
      }
      if (!assignment && line.startsWith("[") && line.endsWith("]")) {
        table = getTable(result, line.slice(1, -1).trim());
        continue;
      }
      assignment = assignment ? `${assignment} ${line}` : line;
      if (isCompleteValue(assignment)) {
        finishAssignment();
      }
    }
    if (assignment) {
      throw new Error(`Unterminated TOML assignment: ${assignment}`);
    }
    return result;
  }

  window.parseTopologyToml = parseTopologyToml;
})();
