'use strict';

const createCase = require('./tools/create-case');
const getCases = require('./tools/get-cases');
const readLocalFiles = require('./tools/read-local-files');
const uploadFiles = require('./tools/upload-files');
const deleteFile = require('./tools/delete-file');

const tools = [createCase, getCases, readLocalFiles, uploadFiles, deleteFile];

const byName = new Map(tools.map((t) => [t.name, t]));

function listTools() {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

function getTool(name) {
  return byName.get(name) || null;
}

module.exports = { listTools, getTool };
