"use strict"
var g = globalThis
if (!g.vscode) {
	throw new Error("global.vscode not set before vscode-mock load")
}
module.exports = g.vscode
