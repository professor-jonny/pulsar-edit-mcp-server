@//start {
  read session notes
  get repo map
}

@//audit-c {
  run checkpatch on the active file and summarise violations by severity
  run namingcheck and report any issues
  fix all ERROR level violations first then WARNING level
}

@//fix-errors {
  run checkpatch on the active file, fix all ERROR level style violations only
}

@//check-docs {
  run check-function-docs on the active file and report missing or wrong-style docs
  then run insert-function-doc for each function flagged as missing
}

@//session-end {
  write session notes summarising what was done and the current version
  call get-edit-stats with reset:true
}
