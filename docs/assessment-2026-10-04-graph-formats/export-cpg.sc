import io.shiftleft.codepropertygraph.generated.nodes._
@main def exec(cpgFile: String, outFile: String) = {
  importCpg(cpgFile)
  def q(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\t", "\\t") + "\""
  def o(x: Option[Int]) = x.map(_.toString).getOrElse("null")
  val sb = new StringBuilder
  sb.append("{\"files\":[")
  sb.append(cpg.file.l.map(f => s"{\"name\":${q(f.name)},\"hash\":${q(f.hash.getOrElse(""))},\"content\":${q(f.content)}}").mkString(","))
  sb.append("],\"typeDecls\":[")
  sb.append(cpg.typeDecl.isExternal(false).l.map(t => s"{\"fullName\":${q(t.fullName)},\"name\":${q(t.name)},\"file\":${q(t.filename)},\"line\":${o(t.lineNumber)},\"col\":${o(t.columnNumber)},\"offset\":${o(t.offset)},\"offsetEnd\":${o(t.offsetEnd)},\"astParentType\":${q(t.astParentType)},\"astParentFullName\":${q(t.astParentFullName)},\"inherits\":[${t.inheritsFromTypeFullName.map(q).mkString(",")}]}").mkString(","))
  sb.append("],\"members\":[")
  sb.append(cpg.member.l.map(m => s"{\"name\":${q(m.name)},\"owner\":${q(m.typeDecl.fullName)},\"line\":${o(m.lineNumber)},\"col\":${o(m.columnNumber)}}").mkString(","))
  sb.append("],\"methods\":[")
  sb.append(cpg.method.isExternal(false).l.map(m => s"{\"fullName\":${q(m.fullName)},\"name\":${q(m.name)},\"file\":${q(m.filename)},\"line\":${o(m.lineNumber)},\"col\":${o(m.columnNumber)},\"lineEnd\":${o(m.lineNumberEnd)},\"colEnd\":${o(m.columnNumberEnd)},\"offset\":${o(m.offset)},\"offsetEnd\":${o(m.offsetEnd)},\"astParentType\":${q(m.astParentType)},\"astParentFullName\":${q(m.astParentFullName)}}").mkString(","))
  sb.append("],\"calls\":[")
  sb.append(cpg.call.filterNot(_.name.startsWith("<operator")).l.map(c => s"{\"name\":${q(c.name)},\"code\":${q(c.code)},\"methodFullName\":${q(c.methodFullName)},\"dispatch\":${q(c.dispatchType)},\"file\":${q(c.method.filename)},\"caller\":${q(c.method.fullName)},\"line\":${o(c.lineNumber)},\"col\":${o(c.columnNumber)},\"offset\":${o(c.offset)},\"offsetEnd\":${o(c.offsetEnd)},\"callees\":[${c.callee.isExternal(false).fullName.l.map(q).mkString(",")}]}").mkString(","))
  sb.append("],\"imports\":[")
  sb.append(cpg.imports.l.map(i => s"{\"entity\":${q(i.importedEntity.getOrElse(""))},\"line\":${o(i.lineNumber)},\"col\":${o(i.columnNumber)},\"file\":${q(i.file.name.headOption.getOrElse(""))}}").mkString(","))
  sb.append("]}")
  java.nio.file.Files.writeString(java.nio.file.Paths.get(outFile), sb.toString)
  println("WROTE " + outFile)
}
