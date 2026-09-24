// T3 delete_block verification fixture

function alpha() {
  // BLOCK_MARKER start
  console.log("alpha block line 1");
  console.log("alpha block line 2");
  // BLOCK_MARKER end
  return 1;
}

function beta() {
  return 2;
}

function gamma() {
  console.log("keep me");
  return 3;
}
