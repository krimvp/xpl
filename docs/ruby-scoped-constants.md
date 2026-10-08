# Ruby scoped constant check

The syntax-only Ruby provider accepts a qualified class, module or assignment target when each owner path
has an earlier class or module declaration in the same file. It searches enclosing lexical paths first,
then the file root. A leading `::` searches only the root. It does not join namespaces across files or
infer an owner from a use of the constant. Children of an omitted qualified class or module are omitted
with it, since their namespace path is unknown. Omitted targets are part of the reported partial coverage;
Ruby still has `refs: none`.

Pinned sample: `rack/rack` at `a9833c8f3bd6b6d1e0ab35de00a1f1a16b5095f5` (2026-10-09). A manual
search of the 95 `.rb` files found one live `::CONST =` assignment:

| Source | Checked owner | Indexed result |
| --- | --- | --- |
| `lib/rack/builder.rb:6`, `Rack::BUILDER_TOPLEVEL_BINDING =` | `module Rack; end` at line 5 | `lib/rack/builder.rb#Rack.BUILDER_TOPLEVEL_BINDING`, parent `lib/rack/builder.rb#Rack`, range 6–6 |

`lib/rack/mock_request.rb:85` has a commented `URI::Parser =` and produces no declaration. The fresh
no-cache build produced 1,169 Ruby symbols from 95 files. The first build after the Ruby profile bump had
9 extraction hits for other cached files; the warm build had 104 hits across all file-local facts. The
no-cache, first cached and warm indexes have equal content,
including the selected declaration and no references. Two JavaScript fixture files have syntax warnings,
so these counts do not establish complete Rack coverage.

`test/helper.rb:29` reopens `Minitest::Spec`, whose owner has no same-file declaration. Its two methods
are omitted with that class; assigning either method to the file root would be a false ID.
