; Named PHP declarations only. Dynamic calls and inheritance are not resolved.
(namespace_definition name: (namespace_name) @name) @definition.module
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.type
(class_declaration name: (name) @name) @definition.class
(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method
(const_element (name) @name) @definition.variable
