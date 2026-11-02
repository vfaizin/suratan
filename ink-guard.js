// Makes dividing by zero an Ink error. Left alone, inkjs shows the player "Infinity"
// for 1 / 0, and crashes with no useful message on 0 / 0 and on mod 0.
// Loaded after vendor/ink-full.js, by the page and by the bot alike, so the vendored
// file stays as published. This is the tool's rule: the game's own Ink won't have it.
{
  const perform = inkjs.Story.prototype.PerformLogicAndFlowControl;
  inkjs.Story.prototype.PerformLogicAndFlowControl = function (obj) {
    if (obj && (obj.name === "/" || obj.name === "%")) {
      // The sum runs next, on the top of the stack: the divisor. false counts as 0 in Ink.
      const stack = this.state.evaluationStack;
      const divisor = stack[stack.length - 1]?.value;
      if (divisor === 0 || divisor === false) this.Error("Divide by zero");
    }
    return perform.call(this, obj);
  };
}
