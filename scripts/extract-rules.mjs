#!/usr/bin/env node
/**
 * Flatten a CBPR+/MyStandards JSON Schema into a list of leaf-field rules.
 * Output per leaf:
 *   { path, jsonPath, xmlPath, mandatory, type, ref, pattern, minLength, maxLength, enum }
 *
 * Usage:
 *   node scripts/extract-rules.mjs <path-to-schema.json>
 */
import fs from 'fs';
import path from 'path';

const file = process.argv[2];
if (!file) { console.error('Usage: extract-rules.mjs <schema.json>'); process.exit(1); }
const schema = JSON.parse(fs.readFileSync(file, 'utf8'));

const defs = schema.definitions || {};

// snake_case -> CamelCase (ISO 20022 XML tag) heuristic
function snakeToXml(s) {
  return s.split('_').map(w => w === 'identification' ? 'Id'
    : w === 'creation' ? 'Cre'
    : w === 'date' ? 'Dt'
    : w === 'time' ? 'Tm'
    : w[0].toUpperCase() + w.slice(1)).join('');
}

// Better: use the "description" field of definitions to get the XML tag, fall back to snake-to-CamelCase
// For now we just compose using the JSON-path tokens; mapping to XML happens later by user.

// Constraints we want to surface
function leafConstraints(def) {
  if (!def) return {};
  const out = {};
  if (def.pattern) out.pattern = def.pattern;
  if (def.minLength != null) out.minLength = def.minLength;
  if (def.maxLength != null) out.maxLength = def.maxLength;
  if (def.enum) out.enum = def.enum;
  if (def.minimum != null) out.minimum = def.minimum;
  if (def.maximum != null) out.maximum = def.maximum;
  if (def.fractionDigits != null) out.fractionDigits = def.fractionDigits;
  if (def.totalDigits != null) out.totalDigits = def.totalDigits;
  return out;
}

// Recursively walk schema. For each leaf (primitive), emit a rule entry.
// Use breadcrumb of JSON property names for path; track required-ness from parent.
function resolveRef(refStr) {
  if (!refStr || !refStr.startsWith('#/definitions/')) return null;
  return defs[refStr.slice('#/definitions/'.length)];
}

function isPrimitive(def) {
  if (!def) return false;
  if (def.type && def.type !== 'object' && def.type !== 'array') return true;
  // also enum-only choices
  if (def.enum) return true;
  return false;
}

const visited = new Set();
const rules = [];

function walk(def, jsonPath, requiredByParent, depth = 0) {
  if (!def) return;
  if (depth > 25) return;

  // Follow $ref
  if (def.$ref) {
    const target = resolveRef(def.$ref);
    if (!target) return;
    const refName = def.$ref.slice('#/definitions/'.length);
    // Primitive ref: emit a leaf
    if (isPrimitive(target)) {
      rules.push({
        jsonPath,
        ref: refName,
        type: target.type,
        mandatory: !!requiredByParent,
        ...leafConstraints(target),
        description: target.description?.slice(0, 100),
      });
      return;
    }
    // Cycle protection (only for non-primitive recursive walks)
    const key = jsonPath + '|' + refName;
    if (visited.has(key)) return;
    visited.add(key);
    return walk(target, jsonPath, requiredByParent, depth + 1);
  }

  // oneOf / anyOf / allOf
  if (def.oneOf) { def.oneOf.forEach(sub => walk(sub, jsonPath, requiredByParent, depth + 1)); return; }
  if (def.anyOf) { def.anyOf.forEach(sub => walk(sub, jsonPath, requiredByParent, depth + 1)); return; }
  if (def.allOf) { def.allOf.forEach(sub => walk(sub, jsonPath, requiredByParent, depth + 1)); return; }

  // Array
  if (def.type === 'array' && def.items) {
    return walk(def.items, jsonPath + '[]', requiredByParent, depth + 1);
  }

  // Object
  if (def.type === 'object' || def.properties) {
    const required = new Set(def.required || []);
    for (const propName of Object.keys(def.properties || {})) {
      const child = def.properties[propName];
      const childPath = jsonPath ? `${jsonPath}.${propName}` : propName;
      const isReq = required.has(propName) && !!requiredByParent;
      walk(child, childPath, isReq || requiredByParent && required.has(propName), depth + 1);
    }
    return;
  }

  // Primitive in-place
  if (isPrimitive(def)) {
    rules.push({
      jsonPath,
      type: def.type,
      mandatory: !!requiredByParent,
      ...leafConstraints(def),
    });
  }
}

// Find the root: properties.<root_message>.$ref
const rootProp = Object.keys(schema.properties).find(k => k !== '$id');
const rootRef = schema.properties[rootProp];
walk(rootRef, '', true, 0);

console.log(JSON.stringify({ source: path.basename(file), rootProp, ruleCount: rules.length, rules }, null, 2));
