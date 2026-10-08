; Source-backed declarations only. Call nodes cannot establish Ruby dispatch targets.
(class name: [(constant) (scope_resolution)] @name) @definition.class
(module name: [(constant) (scope_resolution)] @name) @definition.module
(method name: (_) @name) @definition.method
(singleton_method object: (_) @context name: (_) @name) @definition.method
(assignment left: (constant) @name) @definition.variable
(assignment left: (scope_resolution) @name) @definition.variable
