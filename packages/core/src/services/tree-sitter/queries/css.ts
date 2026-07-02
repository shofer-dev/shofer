/*
CSS Tree-Sitter Query Patterns

Previously every pattern included a (#match? ... "test-...") predicate that filtered
captures to test-fixture strings only. Those predicates meant NO real-world CSS was
ever captured during indexing — a CSS file's keyframes, rulesets, variables, etc. were
all silently dropped. The fix removes every (#match?) predicate so real CSS is indexed.
*/
const cssQuery = String.raw`
; CSS rulesets and selectors
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.ruleset)) @_rule)

(rule_set
  (selectors
    (pseudo_class_selector
      (class_selector
        (class_name) @name.definition.selector))) @_selector)

; Media queries
(media_statement
  (block
    (rule_set
      (selectors
        (class_selector
          (class_name) @name.definition.media_query)))) @_media)

; Keyframe animations
(keyframes_statement
  (keyframes_name) @name.definition.keyframe) @_keyframe

; Animation related classes
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.animation)) @_animation)

; Functions
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.function)) @_function)

; Variables (CSS custom properties)
(declaration
  (property_name) @name.definition.variable) @_variable

; Import statements
(import_statement
  (string_value) @name.definition.import) @_import

; Nested rulesets
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.nested_ruleset)) @_nested)

; Mixins (using CSS custom properties as a proxy)
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.mixin)) @_mixin)`

export default cssQuery
