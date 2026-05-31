/*
Go Tree-Sitter Query Patterns
Captures full declaration nodes as @definition.xxx (not @name.xxx — these
are whole nodes, not bare identifiers like in TypeScript/other languages).
Uses the same naming convention as every other language query file so the
parser's name-prefix filter works correctly.
*/
export default `
; Function declarations - capture the entire declaration
(function_declaration) @definition.function

; Method declarations - capture the entire declaration
(method_declaration) @definition.method

; Type declarations (interfaces, structs, type aliases) - capture the entire declaration
(type_declaration) @definition.type

; Variable declarations - capture the entire declaration
(var_declaration) @definition.var

; Constant declarations - capture the entire declaration
(const_declaration) @definition.const

; Package clause
(package_clause) @definition.package

; Import declarations - capture the entire import block
(import_declaration) @definition.import
`
