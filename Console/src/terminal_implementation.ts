
import * as XTerm from 'xterm';
const fitAddon = XTerm.loadAddon('fit');

import { TextFormatter, VTESC } from './text_formatter';
import { clipboard } from 'electron';
import { LanguageInterface } from './language_interface';
import {Pipe, ConsoleMessage, ConsoleMessageType} from './pipe';

import * as Rx from 'rxjs';
import { ConnectableObservable } from 'rxjs/observable/ConnectableObservable';

// for julia, replacing backslash entities in the shell like Julia REPL. 

const SymbolTable = require('../data/symbol_table.json');

/**
 * 
 */
class ConsoleHistory {

  private history_: string[] = [];
  private copy_: string[] = [];
  private pointer_ = 0;

  /** language-specific storage key */
  private key_:string;

  constructor(language_label:string){
    this.key_ = "console-history-" + language_label;
  }

  Push(line: string) {
    if (line.length) this.history_.push(line);
  }

  /**
   * write to localstorage
   */
  Store() {
    let json = JSON.stringify(this.history_.slice(0, 1024));
    localStorage.setItem(this.key_, json);
  }

  /** 
   * restore from local storage 
   */
  Restore() {
    let tmp = localStorage.getItem(this.key_);
    if (tmp) this.history_ = JSON.parse(tmp);
  }

  NewLine() {
    if (this.history_.length > 1024) this.history_ = this.history_.slice(this.history_.length - 1024);
    this.copy_ = this.history_.slice(0);
    this.pointer_ = this.copy_.length;
    this.copy_.push("");
  }

  Offset(offset: number, current_buffer: string): (string | false) {
    let index = this.pointer_ + offset;
    if (index < 0 || index >= this.copy_.length) return false;
    let line = this.copy_[index];
    this.copy_[this.pointer_] = current_buffer;
    this.pointer_ = index;
    return line;
  }

}

class Autocomplete {

  visible_ = false;
  last_: any;

  private node_:HTMLElement;

  /**
   * 
   */
  constructor(private accept_: Function, private parent_:HTMLElement) {

    this.node_ = document.createElement("ul");
    this.node_.classList.add("terminal-completion-list");
    document.body.appendChild(this.node_);

    // FIXME: do these need to be attached at all times?
    // if not, we could use a single static node

    this.node_.addEventListener("mousemove", e => {
      let node = e.target as HTMLElement;
      if (node.tagName === "A") node = node.parentElement;
      if (node.tagName !== "LI") return;
      if (!node.classList.contains("active")) {
        let nodes = this.node_.querySelectorAll("li");
        for (let i = 0; i < nodes.length; i++) {
          nodes[i].classList.remove("active");
        }
        node.classList.add("active");
      }
    });

    this.node_.addEventListener("click", e => {
      this.Accept();
    });

  }

  /**
   * show autocomplete. if there's a single completion, we want that to
   * populate immediately; but only if it's the initial tab. if we are 
   * showing the list, then as the user types we narrow choices but we
   * don't automatically select the last option (that's what the flag
   * argument is for).
   */
  Show(acceptSingleCompletion = true) {

    if (!this.last_ || !this.last_.comps) {
      this.Dismiss();
      return;
    }

    let comps = this.last_.comps.split(/\n/);

    if( comps.length === 1 && acceptSingleCompletion ){
      this.Dismiss();
      let addition = comps[0].substr(this.last_.token.length);

      // FIXME: this needs to get parameterized to call back to the 
      // language implementation. for now it's OK since R will never 
      // have a symbol that looks like this...

      let scrub = 0;
      if( addition.length === 0 && /^\\/.test(this.last_.token)){
        //addition = HE.decode(`&${this.last_.token.substr(1)};`); 
        addition = SymbolTable.symbols[this.last_.token.substr(1)] || addition;
        scrub = this.last_.token.length;
      }
      
      this.accept_(addition, scrub);
      
      return;
    }

    this.node_.textContent = "";
    comps.forEach((comp, index) => {
      let li = document.createElement("li");
      let a = document.createElement("a");
      a.textContent = comp;
      li.appendChild(a);
      if (!index) li.classList.add("active");
      this.node_.appendChild(li);
    });

    let cursorNode = this.parent_.querySelector(".terminal-cursor") as HTMLElement;
    this.node_.scrollTop = 0;
    let cursor_bounds = cursorNode.getBoundingClientRect();

    let top = Math.round(cursor_bounds.top - this.node_.offsetHeight);
    if (top < 0) top = Math.round(cursor_bounds.bottom); 

    let left = Math.round(cursor_bounds.left);

    // FIXME: move to the left if necessary

    this.node_.style.top = `${top}px`;
    this.node_.style.left = `${left}px`;
    this.node_.style.opacity = "1";
    this.visible_ = true;

  }

  Dismiss() {
    this.node_.style.opacity = "0";
    this.visible_ = false;
  }

  Select(dir: number) {
    let nodes = this.node_.querySelectorAll("li");
    let current = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].classList.contains("active")) {
        nodes[i].classList.remove("active");
        current = i;
        break;
      }
    }
    current += dir;
    if (current < 0) current = nodes.length - 1;
    if (current >= nodes.length) current = 0;

    let node = nodes[current];
    node.classList.add('active');

    let parent = node.parentElement;
    let bottom = node.offsetTop + node.offsetHeight;

    if (bottom > parent.offsetHeight + parent.scrollTop) {
      parent.scrollTop = bottom - parent.offsetHeight;
    }
    else if (node.offsetTop < parent.scrollTop) {
      parent.scrollTop = node.offsetTop;
    }
  }

  Accept() {

    let nodes = this.node_.querySelectorAll("li");
    let accepted = undefined;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].classList.contains("active")) {
        accepted = nodes[i].textContent;
        break;
      }
    }
    this.Dismiss();

    // console.info("tl?", this.last_, accepted );

    let addition = accepted.substr(this.last_.token.length);
    this.accept_(addition);

  }

  Update(data: any) {
    this.last_ = data;
  }

}

export interface AutocompleteCallbackType { (buffer: string, position: number): Promise<any> }

export interface ExecCallbackType { (buffer: string): Promise<any> }

/*
export interface TerminalConfig {

  // nodes

  node_: HTMLElement;

  / *
  // callbacks

  autocomplete_callback_: AutocompleteCallbackType;
  exec_callback_: ExecCallbackType;
  break_callback_: Function;

  // objects

  formatter_: TextFormatter;
  * /

  language_interface_:LanguageInterface;

}
*/

export interface PromptMessage {
  text?:string;
  push_stack?:boolean;
  pop_stack?:boolean;
}

/**
 * abstracting line info. we want to move operations into this class
 * and use accessors. it breaks down a bit and gets messy when we are 
 * inserting, but it's still worthwhile for the most part.
 */
export class LineInfo {

  private cursor_position_ = 0;
  private buffer_ = "";
  
  /**
   * not sure how I feel about constructor-declared properties. it kinds
   * of obscures them (although if you just rely on tooling, they'll be 
   * visible).
   */
  constructor(private prompt_ = ""){}

  append(text:string){
    this.buffer_ += text;
    this.cursor_position_ += text.length;
  }

  /**
   * append, or if the cursor is not at the end, insert at cursor position.
   * in either case increment cursor position by the length of the added text.
   */
  append_or_insert(text:string){
    this.buffer_ = 
      this.buffer_.substr(0, this.cursor_position_) + text +
      this.buffer_.substr(this.cursor_position);
    this.cursor_position_ += text.length;
  }

  /**
   * replace any current text and cursor position. optionally set position
   * to end of line.
   */
  set(buffer:string, cursor_position = -1){
    if( cursor_position === -1 ) cursor_position = buffer.length;
    this.cursor_position_ = cursor_position;
    this.buffer_ = buffer;
  }

  get offset_from_end(){
    return this.buffer_.length - this.cursor_position_;
  }

  /** accessor */
  get prompt(){ return this.prompt_; }

  /** accessor */
  get buffer(){ return this.buffer_; }

  /** accessor */
  get cursor_position(){ return this.cursor_position_; }

  /** accessor */
  set cursor_position(cursor_position:number){ this.cursor_position_ = cursor_position; }

  /** get the full line of text, including prompt */
  get full_text(){ return this.prompt_ + this.buffer_ }

  /** get text left of the cursor */
  get left(){ return this.buffer_.substr(0, this.cursor_position_); }
  
  /** get text right of the cursor */
  get right(){ return this.buffer_.substr(this.cursor_position_); }

}

enum ConsolePrintFlags {
  None = 0, 
  Error = 1
}

interface PrintLineFunction { (line: string, lastline: boolean, flags: ConsolePrintFlags ): void }

/**
 * FIXME: enumerated event types
 */
interface TerminalEvent {
  type:string
}

/**
 * implementation of the terminal on top of xtermjs.
 */
export class TerminalImplementation {

  private xterm_: XTerm = null;
  private line_info_ = new LineInfo();
  private history_:ConsoleHistory; 

  private current_tip_: any;
  private dismissed_tip_: any;
  private autocomplete_: Autocomplete;

  private static function_tip_node_:HTMLElement;

  // private prompt_stack_: string[] = [];
  private prompt_stack_:LineInfo[] = [];

  private PrintLine:PrintLineFunction;

  /**
   * we use a static event source for events that are application-global,
   * which may arise out of any existing terminal.
   * 
   * FIXME: I'm not sure about this being static. maybe better to have each
   * instance broadcast events, then have the container (in our case, mux)
   * consolidate, and have anyone else listen to that.
   * 
   */
  private static events_:Rx.Subject<TerminalEvent> = new Rx.Subject<TerminalEvent>();

  /** accessor */
  public static get events() { return this.events_; }

  constructor(private language_interface_:LanguageInterface, private node_:HTMLElement){

    this.history_ = new ConsoleHistory((language_interface_.label_||"").toLocaleLowerCase());
    this.history_.Restore();

    if( !TerminalImplementation.function_tip_node_ ){
      TerminalImplementation.function_tip_node_ = document.createElement("div");
      TerminalImplementation.function_tip_node_.classList.add("terminal-tooltip");
      document.body.appendChild(TerminalImplementation.function_tip_node_);
    }

    if( this.language_interface_.formatter_ ){
      this.PrintLine = (line:string, lastline = false, flags = ConsolePrintFlags.None) => {
        let formatted = this.language_interface_.formatter_.FormatString(line);
        if (lastline) this.xterm_.write(formatted);
        else this.xterm_.writeln(formatted);
      };
    }
    else {
      this.PrintLine = (line:string, lastline = false, flags = ConsolePrintFlags.None) => {
        if( flags & ConsolePrintFlags.Error ){
          line = `${VTESC}91m` + line + `${VTESC}0m`;
        }
        let formatted = line;
        if (lastline) this.xterm_.write(formatted);
        else this.xterm_.writeln(formatted);
      };
    }
 

  }

  /** focus */
  Focus(){ this.xterm_.focus(); }

  /**
   * any housekeeping before closing
   */
  CleanUp() {
    this.history_.Store();
  }

  private RunAutocomplete() {
    
    let thennable = this.language_interface_.AutocompleteCallback(this.line_info_.buffer, this.line_info_.cursor_position);

    if(thennable) thennable.then(autocomplete_response => {
      if (!autocomplete_response) return;
      this.autocomplete_.Update(autocomplete_response);
      if (this.autocomplete_.visible_) {
        this.autocomplete_.Show(false);
      }
      else {
        this.FunctionTip(autocomplete_response['function.signature'], autocomplete_response.fguess);
      }
    });

  }

  DismissTooltip() {
    this.dismissed_tip_ = this.line_info_.cursor_position;
  }

  FunctionTip(message?: string, function_guess?: string) {
    
    if (!message) TerminalImplementation.function_tip_node_.style.opacity = "0";
    else {

      if (message === this.dismissed_tip_) return;
      let cursor_node = this.node_.querySelector(".terminal-cursor") as HTMLElement

      // FIXME: generalize this into finding position of a character, 
      // we can probably use it again

      let m = this.line_info_.buffer.match(new RegExp(function_guess + "\\s*\\(", "i"));
      let range = document.createRange();
      let node = cursor_node.previousSibling.firstChild as HTMLElement;

      range.selectNodeContents(node);
      range.setEnd(node, m.index + this.line_info_.prompt.length);
      let rect = range.getBoundingClientRect();

      this.current_tip_ = message;
      this.dismissed_tip_ = null;

      node = TerminalImplementation.function_tip_node_;
      node.textContent = message;

      node.style.left = `${rect.right}px`;
      
      let client_rect = cursor_node.getBoundingClientRect();
      let top = client_rect.top - node.offsetHeight;

      if (top < 0) { top = rect.bottom + 2; }

      node.style.top = `${top}px`;
      node.style.opacity = "1";

    }
  }

  /**
   * left or right delete (by sign)
   * FIXME: multiple? would be handy
   */
  DeleteText(dir: number) {

    if (dir > 0) { // delete right
      if (this.line_info_.cursor_position >= this.line_info_.buffer.length) return;
      let balance = this.line_info_.right.substr(1);
      this.ClearRight();
      this.xterm_.write(balance);
      this.MoveCursor(-balance.length);
      this.line_info_.set(this.line_info_.left + balance, this.line_info_.cursor_position);
    }
    else { // delete left (ruboff)
      if (this.line_info_.cursor_position <= 0) return;
      let balance = this.line_info_.buffer.substr(this.line_info_.cursor_position);
      this.xterm_.write(`${VTESC}D${VTESC}0K${balance}`)
      this.MoveCursor(-balance.length);
      this.line_info_.set(this.line_info_.buffer.substr(0, this.line_info_.cursor_position - 1) + balance, this.line_info_.cursor_position-1);
    }

    this.RunAutocomplete();
  }

  /** 
   * type a character 
   */
  Type(key: string) {

    if (this.line_info_.cursor_position < this.line_info_.buffer.length) {
      this.xterm_.write(key);
      this.xterm_.write(this.line_info_.right);
      this.MoveCursor(-this.line_info_.right.length);
    }
    else {
      this.xterm_.write(key);
    }
    this.line_info_.append_or_insert(key);

    this.RunAutocomplete();
  }

  OffsetHistory(dir: number) {
    let text = this.history_.Offset(dir, this.line_info_.buffer);
    if (text === false) return;
    if (this.line_info_.cursor_position > 0) this.MoveCursor(-this.line_info_.cursor_position);
    this.Escape(`K${text}`);
    this.line_info_.set(text);
  }

  Prompt(prompt:PromptMessage) {

    let text = prompt.text;

    if( prompt.push_stack ){

      console.info("push prompt stack: ", JSON.stringify(prompt) );

      this.prompt_stack_.unshift(this.line_info_);

      // move left and clear line before writing
      this.MoveCursor(-this.line_info_.full_text.length);
      this.ClearRight();
    }
    
    if( prompt.pop_stack ){
      this.line_info_ = this.prompt_stack_.shift();
    }
    else {
      this.line_info_ = new LineInfo(prompt.text);
    }

    this.xterm_.write(this.line_info_.full_text);
    if( this.line_info_.offset_from_end ) this.MoveCursor(-this.line_info_.offset_from_end);

    this.history_.NewLine();
  }

  Write(text: string) {
    this.xterm_.write(text);
  }

  /*
  PrintLine = function (line: string, lastline = false) {
    let formatted = this.config_.formatter_.FormatString(line);
    if (lastline) this.xterm_.write(formatted);
    else this.xterm_.writeln(formatted);
  }
  */

  PrintConsole(text: string, offset = false, flags = ConsolePrintFlags.None ) {

    // if not busy, meaning we're waiting at a prompt, we want any
    // stray console messages to appear above (to the left of) the 
    // prompt and push down, preserving prompt and any current line
    // (and cursor pos within the line).

    // this is kind of expensive, so we should look at doing some 
    // batching of console messages, preferably server side but 
    // also client side.

    let lines = text.split(/\n/);
    if (offset) {
      this.MoveCursor(-this.line_info_.full_text.length);
      this.ClearRight();
      lines.forEach((line, index) => this.PrintLine(line, index === (lines.length - 1), flags));
      this.xterm_.write(this.line_info_.full_text);
      if(this.line_info_.offset_from_end) this.MoveCursor(-this.line_info_.offset_from_end);
    }
    else {
      lines.forEach((line, index) => this.PrintLine(line, index === (lines.length - 1), flags));
    }
  }

  ClearShell() {
    this.xterm_.clear();
  }

  ShowCursor(show = true) {
    this.Escape(show ? "?25h" : "?25l"); // FIXME: inline
  }

  Escape(command: string) {
    this.xterm_.write(`\x1b[${command}`);
  }

  /**
   * xterm abstraction: clear line from cursor right
   */
  ClearRight(){
    this.Escape("K");
  }

  /** 
   * xterm abstraction: move cursor left or right (columns), by sign  
   */
  MoveCursor(columns:number){
    if(!columns) return; 
    let char = columns > 0 ? 'C' : 'D';
    this.Escape(`${Math.abs(columns)}${char}`);
  }

  Copy() {
    let text = this.xterm_.getSelection();
    clipboard.writeText(text);
  }

  Paste(text?: string) {

    this.xterm_.scrollToBottom();
    
    if (!text) text = (clipboard.readText() || "");

    // FIXME: cursor pos

    let lines = (text || "").split(/\n/).map(x => x.trim());
    console.info(lines, lines.length);

    lines.reduce((a, line, index) => {
      return new Promise((resolve, reject) => {
        a.then(() => {
          if (lines.length > (index + 1)) {
            this.xterm_.writeln(line);
            if (!index) line = this.line_info_.buffer + line;
            this.line_info_.set("");
            this.history_.Push(line);
            this.language_interface_.ExecCallback(line).then(x => {
              this.Prompt(x);
              resolve(x);
            });
          }
          else {

            // what if we're pasting at the cursor, which is not at 
            // the end? handled? FIXME

            this.xterm_.write(line);
            this.line_info_.set(this.line_info_.buffer + line);
            resolve();
          }
        });
      });
    }, Promise.resolve());
  }

  KeyDown(key: string, event: any) {

    if (event.ctrlKey) {
      switch (event.key) {
        case "PageUp":
          TerminalImplementation.events_.next({ type: "previous-tab" });
          break;
        case "PageDown":
          TerminalImplementation.events_.next({ type: "next-tab" });
          break;
        case "e":
          TerminalImplementation.events_.next({ type: "release-focus" });
          break;
        case "c":
          this.language_interface_.BreakCallback();
          break;
        default:
          console.info("ctrl (unhandled):", event);
      }
      this.FunctionTip(); // hide
    }
    else if (event.altKey) {
      console.info("alt");
      this.FunctionTip(); // hide
    }
    else {
      let c = key.charCodeAt(0);
      if (c >= 0x20 && c !== 127) {
        this.Type(key);
      }
      else {
        switch (event.key) {

          case "ArrowUp":
            if (this.autocomplete_.visible_) { this.autocomplete_.Select(-1); return; }
            else this.OffsetHistory(-1);
            break;

          case "ArrowDown":
            if (this.autocomplete_.visible_) { this.autocomplete_.Select(1); return; }
            else this.OffsetHistory(1);
            break;

          case "ArrowLeft":
            if (this.line_info_.cursor_position > 0) {
              this.Escape("D");
              this.line_info_.cursor_position--;
            }
            break;

          case "ArrowRight":
            if (this.line_info_.cursor_position < this.line_info_.buffer.length) {
              this.Escape("C");
              this.line_info_.cursor_position++;
            }
            break;

          case "Escape":
            this.DismissTooltip();
            this.autocomplete_.Dismiss();
            break;

          case "Tab":
            if (this.autocomplete_.visible_) { this.autocomplete_.Accept(); return; }
            this.autocomplete_.Show();
            break;

          case "End":
            if(this.line_info_.offset_from_end) // this.Escape(`${this.line_info_.offset_from_end}C`);
              this.MoveCursor(this.line_info_.offset_from_end);
            this.line_info_.cursor_position = this.line_info_.buffer.length;
            break;

          case "Home":
            if (this.line_info_.cursor_position > 0) {
              //this.Escape(`${this.line_info_.cursor_position}D`);
              this.MoveCursor(-this.line_info_.cursor_position);
            }
            this.line_info_.cursor_position = 0;
            break;

          case "Backspace":
            this.DeleteText(-1);
            if (this.autocomplete_.visible_) this.RunAutocomplete();
            break;

          case "Delete":
            this.DeleteText(1);
            break;

          case "Enter":
            if (this.autocomplete_.visible_) { this.autocomplete_.Accept(); return; }
            this.xterm_.write('\r\n');
            this.history_.Push(this.line_info_.buffer);
            this.language_interface_.ExecCallback(this.line_info_.buffer).then(x => this.Prompt(x));
            this.dismissed_tip_ = null;
            break;

          default:
            console.info(c, event.key);
        }
        this.FunctionTip(); // hide

      }

    }

  }

  Resize(){
    this.xterm_.fit();
  }

  Init() {

    this.xterm_ = new XTerm({
      cols: 80, cursorBlink: true
    });

    this.xterm_.open(this.node_, { focus: true });
    this.xterm_.fit();
    this.xterm_.write(`\x1b[\x35 q`);

    let ac_accept = (addition:string, scrub = 0) => {

      if(scrub > 0){
        for( let i = 0; i< scrub; i++ ) this.DeleteText(-1);
      }

      this.xterm_.write(addition);
      this.line_info_.append_or_insert(addition);      
      this.RunAutocomplete();
    };

    this.autocomplete_ = new Autocomplete(ac_accept, this.node_);

    window.addEventListener("resize", event => {
      this.xterm_.fit(); // fixme: debounce?
    });

    this.xterm_.on("key", (key, event) => this.KeyDown(key, event));

    this.xterm_.on("title", title => {
      console.info( "title change:", title ); // ??
    });

    if(this.language_interface_.stdout_pipe_){
      this.language_interface_.stdout_pipe_.data.subscribe( text => {
        this.PrintConsole(text, !this.language_interface_.pipe_.busy);
      });
    }

    if(this.language_interface_.stderr_pipe_){
      this.language_interface_.stderr_pipe_.data.subscribe( text => {
        this.PrintConsole(text, !this.language_interface_.pipe_.busy, ConsolePrintFlags.Error);
      });
    }
    
    this.language_interface_.pipe_.console_messages.subscribe(console_message => {
      if( console_message.type === ConsoleMessageType.PROMPT ){
        console.info(`(${this.language_interface_.label_}) Prompt (${console_message.id})`, console_message.text);
        this.Prompt({
          text: console_message.text,
          push_stack: console_message.id !== 0 // true
        });
      }
      else {
        this.PrintConsole(console_message.text, !this.language_interface_.pipe_.busy);
      }
    });

  }

}