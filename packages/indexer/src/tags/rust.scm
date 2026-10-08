; Corrected tree-sitter-rust 0.24.0 tags. Based on its queries/tags.scm.
; Stock methods duplicate functions and classify inline module functions as methods.
; Capture each function once; tagged lexical impl/trait parents classify methods.
; Stock class tags erase enum/type-alias kinds; preserve those distinctions.
; Add required trait signatures and const/static definitions omitted by stock tags.
; Capture impl declarations with any receiver/trait syntax, including generics and scoped types.
; Stock implementation references cover only simple identifiers and give no impl parent.
; Reference captures are omitted: syntax alone cannot establish a resolved graph edge.

(struct_item name: (type_identifier) @name) @definition.class
(field_declaration name: (field_identifier) @name) @definition.variable
(enum_item name: (type_identifier) @name) @definition.enum
(enum_variant name: (identifier) @name) @definition.variable
(union_item name: (type_identifier) @name) @definition.class
(type_item name: (type_identifier) @name) @definition.type
(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.function
(trait_item name: (type_identifier) @name) @definition.interface
(mod_item name: (identifier) @name) @definition.module
(macro_definition name: (identifier) @name) @definition.macro
(const_item name: (identifier) @name) @definition.variable
(static_item name: (identifier) @name) @definition.variable
(impl_item type: (_) @name !trait) @definition.impl
(impl_item trait: (_) @context type: (_) @name) @definition.impl
