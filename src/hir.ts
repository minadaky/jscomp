// Copyright (c) 2015 Tzvetan Mikov.
// Licensed under the Apache License v2.0. See LICENSE in the project
// root for complete license information.

/// <reference path="../typings/tsd.d.ts" />

import assert = require("assert");
import util = require("util");
import stream = require("stream");

import StringMap = require("../lib/StringMap");
import bmh = require("../lib/bmh");

export class MemValue
{
    constructor(public id: number) {}
}

export class LValue extends MemValue
{
}

export class NullReg extends LValue
{
    toString (): string { return "#nullReg"; }
}

export class Regex
{
    constructor (public pattern: string, public flags: string) {}
    toString(): string { return `Regex(/${this.pattern}/${this.flags})`; }
}

/** for null and undefined */
export class SpecialConstantClass
{
    constructor (public name: string) {}
    toString(): string { return `#${this.name}`; }
}

export type RValue = MemValue | string | boolean | number | Regex | SpecialConstantClass;

export class Param extends MemValue
{
    index: number;
    name: string;
    variable: Var;

    constructor(id: number, index: number, name: string, variable: Var)
    {
        super(id);
        this.index = index;
        this.name = name;
        this.variable = variable;
        variable.formalParam = this;
    }
    toString() { return `Param(${this.index}/*${this.name}*/)`; }
}

export class ArgSlot extends MemValue
{
    local: Local = null;

    constructor (id: number, public index: number) { super(id); }
    toString() {
        if (this.local)
            return this.local.toString();
        else
            return `Arg(${this.index})`;
    }
}

export class Var extends LValue
{
    envLevel: number; //< environment nesting level
    name: string;
    formalParam: Param = null; // associated formal parameter
    escapes: boolean = false;
    constant: boolean = false;
    accessed: boolean = true;
    funcRef: FunctionBuilder = null;
    local: Local = null; // The corresponding local to use if it doesn't escape
    param: Param = null; // The corresponding param to use if it is constant and doesn't escape
    envIndex: number = -1; //< index in its environment block, if it escapes

    constructor(id: number, envLevel: number, name: string)
    {
        super(id);
        this.envLevel = envLevel;
        this.name = name || "";
    }

    toString()
    {
        if (this.local)
            return this.local.toString();
        else if (this.param)
            return this.param.toString();
        else
            return `Var(env@${this.envLevel}[${this.envIndex}]/*${this.name}*/)`;
    }
}

export class Local extends LValue
{
    isTemp: boolean = false; // for users of the module. Has no meaning internally
    index: number;

    constructor(id: number, index: number)
    {
        super(id);
        this.index = index;
    }
    toString() { return `Local(${this.index})`; }
}

export var nullValue = new SpecialConstantClass("null");
export var undefinedValue = new SpecialConstantClass("undefined");
export var nullReg = new NullReg(0);

export function unwrapImmedate (v: RValue): any
{
    if (v === nullValue)
        return null;
    else if (v === undefinedValue)
        return void 0;
    else
        return v;
}

export function wrapImmediate (v: any): RValue
{
    if (v === void 0)
        return undefinedValue;
    else if (v === null)
        return nullValue;
    else
        return v;
}

export function isImmediate (v: RValue): boolean
{
    switch (typeof v) {
        case "string":
        case "boolean":
        case "number":
            return true;
        case "object":
            return <any>v instanceof SpecialConstantClass || <any>v instanceof Regex;
    }
    return false;
}

export function isString (v: RValue): boolean
{
    return typeof v === "string";
}

export function isLValue (v: RValue): LValue
{
    if (<any>v instanceof LValue)
        return <LValue>v;
    else
        return null;
}

export function isVar (v: RValue): Var
{
    if (<any>v instanceof Var)
        return <Var>v;
    else
        return null;
}

export function isTempLocal (v: RValue): Local
{
    if (<any>v instanceof Local) {
        var l = <Local>v;
        if (l.isTemp)
            return l;
    }
    return null;
}


// Note: in theory all comparisons can be simulated using only '<' and '=='.
// a < b   = LESS(a,b)
// a > b   = LESS(b,a)
// a >= b  = !LESS(a,b)
// a <= b  = !LESS(b,a)
// a != b  = !(a == b)
// However things fall apart first when floating point is involved (because comparions between
// NaN-s always return false) and second because JavaScript requires left-to-right evaluation and
// converting to a primitive value for comparison could cause a function call.

export const enum OpCode
{
    // Special
    CLOSURE,
    CREATE,
    LOAD_SC,
    ASM,

    // Binary
    STRICT_EQ,
    STRICT_NE,
    LOOSE_EQ,
    LOOSE_NE,
    LT,
    LE,
    GT,
    GE,
    SHL_N,
    SHR_N,
    ASR_N,
    ADD,
    ADD_N,
    SUB_N,
    MUL_N,
    DIV_N,
    MOD_N,
    OR_N,
    XOR_N,
    AND_N,
    IN,
    INSTANCEOF,

    // Unary
    NEG_N,
    LOG_NOT,
    BIN_NOT_N,
    TYPEOF,
    VOID,
    DELETE,
    TO_NUMBER,

    // Assignment
    ASSIGN,

    // Property access
    GET,
    PUT,

    // Call
    CALL,
    CALLIND,

    // Unconditional jumps
    RET,
    GOTO,

    // Conditional jumps
    IF_TRUE,
    IF_IS_OBJECT,
    IF_STRICT_EQ,
    IF_STRICT_NE,
    IF_LOOSE_EQ,
    IF_LOOSE_NE,
    IF_LT,
    IF_LE,
    IF_GT,
    IF_GE,

    _BINOP_FIRST = STRICT_EQ,
    _BINOP_LAST = INSTANCEOF,
    _UNOP_FIRST = NEG_N,
    _UNOP_LAST = TO_NUMBER,
    _IF_FIRST = IF_TRUE,
    _IF_LAST = IF_GE,
    _BINCOND_FIRST = IF_STRICT_EQ,
    _BINCOND_LAST = IF_GE,
    _JUMP_FIRST = RET,
    _JUMP_LAST = IF_LE,
}

var g_opcodeName: string[] = [
    // Special
    "CLOSURE",
    "CREATE",
    "LOAD_SC",
    "ASM",

    // Binary
    "STRICT_EQ",
    "STRICT_NE",
    "LOOSE_EQ",
    "LOOSE_NE",
    "LT",
    "LE",
    "GT",
    "GE",
    "SHL_N",
    "SHR_N",
    "ASR_N",
    "ADD",
    "ADD_N",
    "SUB_N",
    "MUL_N",
    "DIV_N",
    "MOD_N",
    "OR_N",
    "XOR_N",
    "AND_N",
    "IN",
    "INSTANCEOF",

    // Unary
    "NEG_N",
    "LOG_NOT",
    "BIN_NOT_N",
    "TYPEOF",
    "VOID",
    "DELETE",
    "TO_NUMBER",

    // Assignment
    "ASSIGN",

    // Property access
    "GET",
    "PUT",

    // Call
    "CALL",
    "CALLIND",

    // Unconditional jumps
    "RET",
    "GOTO",

    // Conditional jumps
    "IF_TRUE",
    "IF_IS_OBJECT",
    "IF_STRICT_EQ",
    "IF_STRICT_NE",
    "IF_LOOSE_EQ",
    "IF_LOOSE_NE",
    "IF_LT",
    "IF_LE",
    "IF_GT",
    "IF_GE",
];

export const enum SysConst
{
    RUNTIME_VAR,
}
var g_sysConstName : string[] = [
    "RUNTIME_VAR",
];

// Note: surprisingly, 'ADD' is not commutative because 'string+x' is not the same as 'x+string'
// Ain't dynamic typing great?
var g_binOpCommutative: boolean[] = [
    true,  //STRICT_EQ,
    true,  //STRICT_NE,
    true,  //LOOSE_EQ,
    true,  //LOOSE_NE,
    false, //LT,
    false, //LE,
    false, //GT,
    false, //GE,
    false, //SHL,
    false, //SHR,
    false, //ASR,
    false, //ADD,
    true,  //ADD_N,
    false, //SUB_N
    true,  //MUL,
    false, //DIV,
    false, //MOD,
    true,  //OR,
    true,  //XOR,
    true,  //AND,
    false, //IN,
    false, //INSTANCEOF
];

export function isCommutative (op: OpCode): boolean
{
    assert(op >= OpCode._BINOP_FIRST && op <= OpCode._BINOP_LAST);
    return g_binOpCommutative[op - OpCode._BINOP_FIRST];
}

export function  isBinop (op: OpCode): boolean
{
    return op >= OpCode._BINOP_FIRST && op <= OpCode._BINOP_LAST;
}

export function isJump (op: OpCode): boolean
{
    return op >= OpCode._JUMP_FIRST && op <= OpCode._JUMP_LAST;
}

export function binopToBincond (op: OpCode): OpCode
{
    assert(op >= OpCode._BINOP_FIRST && op <= OpCode._BINOP_FIRST + OpCode._BINCOND_LAST - OpCode._BINCOND_FIRST);
    return op + OpCode._BINCOND_FIRST - OpCode._BINOP_FIRST;
}

function rv2s (v: RValue): string
{
    if (v === null)
        return "";
    else if (typeof v === "string")
        return "\"" + v + "\""; // FIXME: escaping, etc
    else
        return String(v); // FIXME: regex, other types, etc
}

function oc2s (op: OpCode): string
{
    return g_opcodeName[op];
}

class Instruction {
    constructor (public op: OpCode) {}
}
class ClosureOp extends Instruction {
    constructor (public dest: LValue, public funcRef: FunctionBuilder) { super(OpCode.CLOSURE); }
    toString (): string {
            return `${rv2s(this.dest)} = ${oc2s(this.op)}(${this.funcRef})`;
    }
}
class LoadSCOp extends Instruction {
    constructor (public dest: LValue, public sc: SysConst, public arg?: string) { super(OpCode.LOAD_SC); }
    toString (): string {
        if (!this.arg)
            return `${rv2s(this.dest)} = ${oc2s(this.op)}(${g_sysConstName[this.sc]})`;
        else
            return `${rv2s(this.dest)} = ${oc2s(this.op)}(${g_sysConstName[this.sc]}, ${this.arg})`;
    }
}
class BinOp extends Instruction {
    constructor (op: OpCode, public dest: LValue, public src1: RValue, public src2: RValue) { super(op); }
    toString (): string {
        if (this.src2 !== null)
            return `${rv2s(this.dest)} = ${oc2s(this.op)}(${rv2s(this.src1)}, ${rv2s(this.src2)})`;
        else
            return `${rv2s(this.dest)} = ${oc2s(this.op)}(${rv2s(this.src1)})`;
    }
}
class UnOp extends BinOp {
    constructor (op: OpCode, dest: LValue, src: RValue) { super(op, dest, src, null); }
}
class AssignOp extends UnOp {
    constructor (dest: LValue, src: RValue) { super(OpCode.ASSIGN, dest, src); }
    toString (): string {
        return `${rv2s(this.dest)} = ${rv2s(this.src1)}`;
    }
}

class PutOp extends Instruction {
    constructor (public obj: RValue, public propName: RValue, public src: RValue) { super(OpCode.PUT); }
    toString (): string {
        return `${oc2s(this.op)}(${rv2s(this.obj)}, ${rv2s(this.propName)}, ${rv2s(this.src)})`;
    }
}

class CallOp extends Instruction {
    constructor(
        op: OpCode, public dest: LValue, public fref: FunctionBuilder, public closure: RValue, public args: ArgSlot[]
    )
    {
        super(op);
    }

    toString (): string {
        if (this.fref)
            return `${rv2s(this.dest)} = ${oc2s(this.op)}(${this.fref}, ${this.closure}, [${this.args}])`;
        else
            return `${rv2s(this.dest)} = ${oc2s(this.op)}(${this.closure}, [${this.args}])`;
    }
}
class JumpInstruction extends Instruction {
    constructor (op: OpCode, public label1: Label, public label2: Label)  { super(op); }
}
class RetOp extends JumpInstruction {
    constructor (label1: Label, public src: RValue) { super(OpCode.RET, label1, null); }
    toString (): string {
        return `ret ${this.label1}, ${rv2s(this.src)}`;
    }
}
class GotoOp extends JumpInstruction {
    constructor (target: Label) { super(OpCode.GOTO, target, null); }
    toString(): string {
        return `${oc2s(this.op)} ${this.label1}`;
    }
}
class IfOp extends JumpInstruction {
    constructor (op: OpCode, public src1: RValue, public src2: RValue, onTrue: Label, onFalse: Label)
    {
        super(op, onTrue, onFalse);
    }
    toString (): string {
        if (this.src2 !== null)
            return `${oc2s(this.op)}(${rv2s(this.src1)}, ${rv2s(this.src2)}) ${this.label1} else ${this.label2}`;
        else
            return `${oc2s(this.op)}(${rv2s(this.src1)}) ${this.label1} else ${this.label2}`;
    }
}

export type AsmPattern = Array<string|number>;

class AsmOp extends Instruction {
    constructor (public dest: LValue, public bindings: RValue[], public pat: AsmPattern)
    {
        super(OpCode.ASM);
    }
    toString (): string
    {
        return `${rv2s(this.dest)} = ${oc2s(this.op)}([${this.bindings}], [${this.pat}])`;
    }
}

export class Label
{
    bb: BasicBlock = null;
    constructor(public id: number) {}
    toString() { return `B${this.bb.id}`; }
}

class BasicBlock
{
    id: number;
    body: Instruction[] = [];
    labels: Label[] = [];
    succ: Label[] = [];

    constructor (id: number)
    {
        this.id = id;
    }

    insertAt (at: number, inst: Instruction): void
    {
        this.body.splice(at, 0, inst);
    }

    push (inst: Instruction): void
    {
        this.body.push(inst);
    }

    jump (inst: JumpInstruction): void
    {
        this.push(inst);
        if (inst.label1)
            this.succ.push(inst.label1);
        if (inst.label2)
            this.succ.push(inst.label2);
    }

    placeLabel (lab: Label): void
    {
        assert(!this.body.length);
        assert(!lab.bb);
        lab.bb = this;
        this.labels.push(lab);
    }
}

/**
 *
 * @param op
 * @param v1
 * @param v2
 * @returns  RValue folded value or null if the operands cannot be folded at compile time
 */
export function foldBinary (op: OpCode, v1: RValue, v2: RValue): RValue
{
    if (!isImmediate(v1) || !isImmediate(v2))
        return null;
    var a1: any = unwrapImmedate(v1);
    var a2: any = unwrapImmedate(v2);
    var r: any;
    switch (op) {
        case OpCode.STRICT_EQ: r = a1 === a2; break;
        case OpCode.STRICT_NE: r = a1 !== a2; break;
        case OpCode.LOOSE_EQ:  r = a1 == a2; break;
        case OpCode.LOOSE_NE:  r = a1 != a2; break;
        case OpCode.LT:        r = a1 < a2; break;
        case OpCode.LE:        r = a1 <= a2; break;
        case OpCode.SHL_N:     r = a1 << a2; break;
        case OpCode.SHR_N:     r = a1 >> a2; break;
        case OpCode.ASR_N:     r = a1 >>> a2; break;
        case OpCode.ADD:
        case OpCode.ADD_N:     r = a1 + a2; break;
        case OpCode.SUB_N:     r = a1 - a2; break;
        case OpCode.MUL_N:     r = a1 * a2; break;
        case OpCode.DIV_N:     r = a1 / a2; break;
        case OpCode.MOD_N:     r = a1 % a2; break;
        case OpCode.OR_N:      r = a1 | a2; break;
        case OpCode.XOR_N:     r = a1 ^ a2; break;
        case OpCode.AND_N:     r = a1 & a2; break;
        case OpCode.IN:        return null;
        case OpCode.INSTANCEOF: return null;
        default:               return null;
    }

    return wrapImmediate(r);
}

export function isImmediateTrue (v: RValue): boolean
{
    assert(isImmediate(v));
    return !!unwrapImmedate(v);
}

function isNonNegativeInteger (s: string): boolean
{
    var n = Number(s) | 0; // convert to integer
    return n >= 0 && String(n) === s;
}

/**
 *
 * @param op
 * @param v
 * @returns  RValue folded value or null if the operand cannot be folded at compile time
 */
export function foldUnary (op: OpCode, v: RValue): RValue
{
    if (!isImmediate(v))
        return null;
    var a: any = unwrapImmedate(v);
    var r: any;
    switch (op) {
        case OpCode.NEG_N:     r = -a; break;
        case OpCode.LOG_NOT:   r = !a; break;
        case OpCode.BIN_NOT_N: r = ~a; break;
        case OpCode.TYPEOF:    r = typeof a; break;
        case OpCode.VOID:      r = void 0; break;
        case OpCode.DELETE:    return null;
        case OpCode.TO_NUMBER: r = Number(a); break;
        default: return null;
    }
    return wrapImmediate(r);
}


function bfs (entry: BasicBlock, exit: BasicBlock, callback: (bb: BasicBlock)=>void): void
{
    var visited: boolean[] = [];
    var queue: BasicBlock[] = [];

    function enque (bb: BasicBlock): void {
        if (!visited[bb.id]) {
            visited[bb.id] = true;
            queue.push(bb);
        }
    }
    function visit (bb: BasicBlock): void {
        callback(bb);
        for (var i = 0, e = bb.succ.length; i < e; ++i)
            enque(bb.succ[i].bb );
    }

    // Mark the exit node as visited to guarantee we will visit it last
    visited[exit.id] = true;

    visit(entry);
    while (queue.length)
        visit(queue.shift());
    // Finally generate the exit node
    visit(exit);
}

function buildBlockList (entry: BasicBlock, exit: BasicBlock): BasicBlock[]
{
    var blockList: BasicBlock[] = [];
    bfs(entry, exit, (bb: BasicBlock) => blockList.push(bb));
    return blockList;
}

function mangleName (name: string): string
{
    var res: string = "";
    var lastIndex = 0;
    for ( var i = 0, len = name.length; i < len; ++i ) {
        var ch = name[i];
        if (!(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch === '_')) {
            if (lastIndex < i)
                res += name.slice(lastIndex, i);
            res += '_';
            lastIndex = i + 1;
        }
    }
    if (lastIndex === 0)
        return name;
    if (lastIndex < i)
        res += name.slice(lastIndex, i);
    return res;
}

export class FunctionBuilder
{
    public id: number;
    public module: ModuleBuilder;
    public parentBuilder: FunctionBuilder;
    public closureVar: Var; //< variable in the parent where this closure is kept
    public name: string;
    public mangledName: string; // Name suitable for code generation
    public runtimeVar: string = null;
    public isBuiltIn = false;

    // The nesting level of this function's environment
    private envLevel: number;

    private params: Param[] = [];
    private locals: Local[] = [];
    private vars: Var[] = [];
    private envSize: number = 0; //< the size of the escaping environment block
    private paramSlotsCount: number = 0; //< number of slots to copy params into
    private paramSlots: Local[] = null;
    private argSlotsCount: number = 0; //< number of slots we need to reserve for calling
    private argSlots: ArgSlot[] = [];

    private lowestEnvAccessed: number = -1;

    private nextParamIndex = 0;
    private nextLocalId = 1;
    private nextLabelId = 0;
    private nextBBId = 0;

    private closed = false;
    private curBB: BasicBlock = null;
    private entryBB: BasicBlock = null;
    private exitBB: BasicBlock = null;
    private exitLabel: Label = null;

    public closures: FunctionBuilder[] = [];

    constructor(id: number, module: ModuleBuilder, parentBuilder: FunctionBuilder, closureVar: Var, name: string)
    {
        this.id = id;
        this.module = module;
        this.parentBuilder = parentBuilder;
        this.closureVar = closureVar;
        this.name = name;
        this.mangledName = "fn" + id;
        if (name)
            this.mangledName += "_" + mangleName(name);

        this.envLevel = parentBuilder ? parentBuilder.envLevel + 1 : 0;

        this.nextLocalId = parentBuilder ? parentBuilder.nextLocalId+1 : 1;

        this.entryBB = this.getBB();
        this.exitLabel = this.newLabel();
    }

    toString() { return `Function(${this.id}/*${this.name}*/)`; }

    newClosure (name: string): FunctionBuilder
    {
        var fref = new FunctionBuilder(this.module.newFunctionId(), this.module, this, this.newVar(name), name);
        this.closures.push(fref);
        return fref;
    }

    newBuiltinClosure (name: string, mangledName: string, runtimeVar: string): FunctionBuilder
    {
        var fref = this.newClosure(name);
        fref.mangledName = mangledName;
        fref.runtimeVar = runtimeVar;
        fref.isBuiltIn = true;
        return fref;
    }

    newParam(name: string): Param
    {
        var param = new Param(this.nextLocalId++, this.nextParamIndex++, name, this.newVar(name));
        this.params.push(param);
        return param;
    }

    private getArgSlot(index: number): ArgSlot
    {
        if (index < this.argSlots.length)
            return this.argSlots[index];
        assert(index === this.argSlots.length);

        var argSlot = new ArgSlot(this.nextLocalId++, this.argSlotsCount++);
        this.argSlots.push(argSlot);
        return argSlot;
    }

    newVar(name: string): Var
    {
        var v = new Var(this.nextLocalId++, this.envLevel, name);
        this.vars.push(v);
        return v;
    }

    newLocal(): Local
    {
        var loc = new Local(this.nextLocalId++, this.locals.length);
        this.locals.push(loc);
        return loc;
    }

    newLabel(): Label
    {
        var lab = new Label(this.nextLabelId++);
        return lab;
    }

    setVarAttributes (v: Var, escapes: boolean, accessed: boolean, constant: boolean, funcRef: FunctionBuilder): void
    {
        v.escapes = escapes;
        v.constant = constant;
        v.accessed = accessed;

        if (constant)
            v.funcRef = funcRef;
    }

    private getBB (): BasicBlock
    {
        if (this.curBB)
            return this.curBB;
        else
            return this.curBB = new BasicBlock(this.nextBBId++);
    }

    private closeBB (): void
    {
        this.curBB = null;
    }

    genClosure(dest: LValue, func: FunctionBuilder): void
    {
        this.getBB().push(new ClosureOp(dest, func));
    }
    genAsm (dest: LValue, bindings: RValue[], pat: AsmPattern): void
    {
        assert(!dest || bindings[0] === dest);
        this.getBB().push(new AsmOp(dest || nullReg, bindings, pat));
    }

    genRet(src: RValue): void
    {
        this.getBB().jump(new RetOp(this.exitLabel, src));
        this.closeBB();
    }
    genGoto(target: Label): void
    {
        this.getBB().jump(new GotoOp(target));
        this.closeBB();
    }
    genIfTrue(value: RValue, onTrue: Label, onFalse: Label): void
    {
        if (isImmediate(value))
            return this.genGoto(isImmediateTrue(value) ? onTrue : onFalse);

        this.getBB().jump(new IfOp(OpCode.IF_TRUE, value, null, onTrue, onFalse));
        this.closeBB();
    }
    genIfIsObject(value: RValue, onTrue: Label, onFalse: Label): void
    {
        if (isImmediate(value))
            return this.genGoto(onFalse);

        this.getBB().jump(new IfOp(OpCode.IF_IS_OBJECT, value, null, onTrue, onFalse));
        this.closeBB();
    }
    genIf(op: OpCode, src1: RValue, src2: RValue, onTrue: Label, onFalse: Label): void
    {
        assert(op >= OpCode._BINCOND_FIRST && op <= OpCode._BINCOND_LAST);

        var folded = foldBinary(op, src1, src2);
        if (folded !== null)
            return this.genGoto(isImmediateTrue(folded) ? onTrue : onFalse);

        this.getBB().jump(new IfOp(op, src1, src2, onTrue, onFalse));
        this.closeBB();
    }

    genLabel(label: Label): void
    {
        assert(!label.bb);

        var bb = this.getBB();
        // If the current basic block is not empty, we must terminate it with a jump to the label
        if (bb.body.length) {
            this.getBB().jump(new GotoOp(label));
            this.closeBB();
            bb = this.getBB();
        }
        bb.placeLabel(label);
    }
    genBinop(op: OpCode, dest: LValue, src1: RValue, src2: RValue): void
    {
        assert(op >= OpCode._BINOP_FIRST && op <= OpCode._BINOP_LAST);
        var folded = foldBinary(op, src1, src2);
        if (folded !== null)
            return this.genAssign(dest, folded);

        // Reorder to make it cleaner. e.g. 'a=a+b' instead of 'a=b+a' and 'a=b+1' instead of 'a=1+b'
        if (isCommutative(op) && (dest === src2 || isImmediate(src1))) {
            var t = src1;
            src1 = src2;
            src2 = t;
        }

        this.getBB().push(new BinOp(op, dest, src1, src2));
    }
    genUnop(op: OpCode, dest: LValue, src: RValue): void
    {
        assert(op >= OpCode._UNOP_FIRST && op <= OpCode._UNOP_LAST);
        var folded = foldUnary(op, src);
        if (folded !== null)
            return this.genAssign(dest, folded);

        this.getBB().push(new UnOp(op, dest, src));
    }
    genCreate(dest: LValue, src: RValue): void
    {
        this.getBB().push(new UnOp(OpCode.CREATE, dest, src));
    }
    genLoadRuntimeVar(dest: LValue, runtimeVar: string): void
    {
        this.getBB().push(new LoadSCOp(dest, SysConst.RUNTIME_VAR, runtimeVar));
    }
    genAssign(dest: LValue, src: RValue): void
    {
        if (dest === src)
            return;
        this.getBB().push(new AssignOp(dest, src));
    }

    genPropGet(dest: LValue, obj: RValue, propName: RValue): void
    {
        this.getBB().push(new BinOp(OpCode.GET, dest, obj, propName));
    }
    genPropSet(obj: RValue, propName: RValue, src: RValue): void
    {
        this.getBB().push(new PutOp(obj, propName, src));
    }

    genCall(dest: LValue, closure: RValue, args: RValue[]): void
    {
        if (dest === null)
            dest = nullReg;

        var bb = this.getBB();

        var slots: ArgSlot[] = Array<ArgSlot>(args.length);
        for ( var i = 0, e = args.length; i < e; ++i ) {
            slots[i] = this.getArgSlot(i);
            bb.push(new AssignOp(slots[i], args[i]));
        }

        this.getBB().push(new CallOp(OpCode.CALLIND, dest, null, closure, slots));
    }

    blockList: BasicBlock[] = [];

    close (): void
    {
        if (this.isBuiltIn)
            return;
        if (this.closed)
            return;
        this.closed = true;
        if (this.curBB)
            this.genRet(undefinedValue);
        this.genLabel(this.exitLabel);
        this.exitBB = this.curBB;
        this.closeBB();

        this.blockList = buildBlockList(this.entryBB, this.exitBB);
    }

    prepareForCodegen (): void
    {
        if (this.isBuiltIn)
            return;
        this.processVars();
        this.closures.forEach((fb: FunctionBuilder) => fb.prepareForCodegen());
    }

    private processVars (): void
    {
        // Allocate locals for the arg slots
        this.argSlots.forEach((a: ArgSlot) => {
            a.local = this.newLocal();
        });

        // Allocate parameter locals
        this.paramSlotsCount = 0;
        this.paramSlots = [];

        this.vars.forEach( (v: Var) => {
            if (!v.escapes && v.accessed) {
                if (v.formalParam) {
                    v.local = this.newLocal();
                    this.paramSlots.push( v.local );
                    ++this.paramSlotsCount;
                } else {
                    v.local = this.newLocal();
                }
            }
        });

        // Assign escaping var indexes
        this.envSize = 0;
        this.vars.forEach((v: Var) => {
            if (v.escapes && v.accessed)
                v.envIndex = this.envSize++;
        });

        // Copy parameters
        var instIndex = 0;
        this.params.forEach((p: Param) => {
            var v = p.variable;
            if (!v.param && v.accessed)
                this.entryBB.insertAt(instIndex++, new AssignOp(v, p));
        });

        // Create closures
        this.closures.forEach((fb: FunctionBuilder) => {
            var clvar = fb.closureVar;
            if (clvar && clvar.accessed) {
                var inst: Instruction;
                if (!fb.isBuiltIn)
                    inst = new ClosureOp(clvar, fb);
                else
                    inst = new LoadSCOp(clvar, SysConst.RUNTIME_VAR, fb.runtimeVar);
                this.entryBB.insertAt(instIndex++, inst);
            }
        });

        this.scanAllInstructions();

        // For now instead of finding the lowest possible environment, just find the lowest existing one
        // TODO: scan all escaping variable accesses and determine which environment we really need
        this.lowestEnvAccessed = -1; // No environment at all
        for ( var curb = this.parentBuilder; curb; curb = curb.parentBuilder ) {
            if (curb.envSize > 0) {
                this.lowestEnvAccessed = curb.envLevel;
                break;
            }
        }
    }

    /**
     * Perform operations which need to access every instruction.
     * <ul>
     * <li>Change CALLIND to CALL for all known functions.</li>
     * </ul>
     */
    private scanAllInstructions (): void
    {
        for ( var i = 0, e = this.blockList.length; i < e; ++i )
            scanBlock(this.blockList[i]);

        function scanBlock (bb: BasicBlock): void
        {
            for ( var i = 0, e = bb.body.length; i < e; ++i ) {
                var inst = bb.body[i];
                // Transform CALLIND with a known funcRef into CALL(funcRef)
                //
                if (inst.op === OpCode.CALLIND) {
                    var callInst = <CallOp>inst;

                    var closure: Var;
                    if (closure = isVar(callInst.closure)) {
                        if (closure.funcRef)
                        {
                            callInst.op = OpCode.CALL;
                            callInst.fref = closure.funcRef;
                        }
                    }
                }
            }
        }
    }

    dump (): void
    {
        if (this.isBuiltIn)
            return;
        assert(this.closed);

        this.closures.forEach((ifb: FunctionBuilder) => {
            ifb.dump();
        });

        function ss (slots: Local[]): string {
            if (!slots || !slots.length)
                return "0";
            return `${slots[0].index}..${slots[slots.length-1].index}`;
        }

        console.log(`\n${this.mangledName}://${this.name}`);

        var pslots: string;
        if (!this.paramSlots || !this.paramSlots.length)
            pslots = "0";
        else
            pslots = `${this.paramSlots[0].index}..${this.paramSlots[this.paramSlots.length-1].index}`;
        var aslots: string;
        if (!this.argSlots || !this.argSlots.length)
            aslots = "0";
        else
            aslots = `${this.argSlots[0].local.index}..${this.argSlots[this.argSlots.length-1].local.index}`;

        console.log(`//locals: ${this.locals.length} paramSlots: ${pslots} argSlots: ${aslots} env: ${this.envSize}`);

        for ( var i = 0, e = this.blockList.length; i < e; ++i ) {
            var bb = this.blockList[i];
            console.log(`B${bb.id}:`);
            bb.body.forEach( (inst: Instruction) => {
                console.log(`\t${inst}`);
            });
        }
    }

    private obuf: OutputSegment = null;

    private gen (...params: any[])
    {
        this.obuf.push(util.format.apply(null, arguments));
    }

    private strEnvAccess (envLevel: number): string
    {
        if (envLevel < 0)
            return "NULL";

        if (envLevel === this.envLevel)
            return "frame.escaped";

        var path = "env";
        for ( var fb: FunctionBuilder = this; fb = fb.parentBuilder; ) {
            if (fb.envLevel === envLevel) {
                return path;
            } else if (fb.envSize > 0) {
                path += "->parent";
            }
        }
        assert(false, util.format("cannot access envLevel %d from envLevel %d (%s)", envLevel, this.envLevel, this.name));
    }

    private strEscapingVar (v: Var): string
    {
        assert(v.escapes);
        return util.format("%s->vars[%d]", this.strEnvAccess(v.envLevel), v.envIndex);
    }


    private strMemValue (lv: MemValue): string
    {
        if (lv instanceof Var) {
            if (lv.local)
                return this.strMemValue(lv.local);
            else if (lv.param)
                return this.strMemValue(lv.param);
            else
                return this.strEscapingVar(lv);
        }
        else if (lv instanceof Param) {
            if (lv.index === 0)
                return `argv[${lv.index}]`; // "this" is always available
            else
                return `(argc > ${lv.index} ? argv[${lv.index}] : JS_UNDEFINED_VALUE)`;
        }
        else if (lv instanceof ArgSlot) {
            return this.strMemValue(lv.local);
        }
        else if (lv instanceof Local) {
            return `frame.locals[${lv.index}]`;
        }
        else {
            assert(false, "unsupported LValue "+ lv);
            return "???";
        }
    }

    private strStringPrim(s: string): string
    {
        var res = "s_strings["+this.module.addString(s)+"]";
        if (s.length <= 20)
            res += "/*\"" + escapeCString(s) + "\"*/";
        return res;
    }

    private strRValue (rv: RValue): string
    {
        if (<any>rv instanceof MemValue)
            return this.strMemValue(<MemValue>rv);
        else if (rv === undefinedValue)
            return "JS_UNDEFINED_VALUE";
        else if (rv === nullValue)
            return "JS_NULL_VALUE";
        else if (typeof rv === "number")
            return `js::makeNumberValue(${rv})`;
        else if (typeof rv === "boolean")
            return `js::makeBooleanValue(${rv ? "true":"false"})`;
        else if (typeof rv === "string")
            return `js::makeStringValue(${this.strStringPrim(rv)})`;
        else
            return rv2s(rv);
    }

    private strBlock (bb: BasicBlock): string
    {
        return `B${bb.id}`;
    }

    private strDest (v: LValue): string
    {
        if (v !== nullReg)
            return util.format("%s = ", this.strMemValue(v));
        else
            return "";
    }

    private outCreate (createOp: UnOp): void
    {
        var callerStr: string = "&frame, ";
        this.gen("  %sjs::makeObjectValue(js::objectCreate(%s%s));\n",
            this.strDest(createOp.dest), callerStr, this.strRValue(createOp.src1)
        );
    }

    private outLoadSC (loadsc: LoadSCOp): void
    {
        var src: string;
        switch (loadsc.sc) {
            case SysConst.RUNTIME_VAR:
                src = util.format("js::makeObjectValue(JS_GET_RUNTIME(&frame)->%s)", loadsc.arg);
                break;
            default:
                assert(false, "Usupported sysconst "+ loadsc.sc);
                return;
        }
        this.gen("  %s%s;\n", this.strDest(loadsc.dest), src);
    }

    private generateAsm (asm: AsmOp): void
    {
        this.gen("{");
        for ( var i = 0, e = asm.pat.length; i < e; ++i )
        {
            var pe = asm.pat[i];
            if (typeof pe === "string") {
                this.gen(<string>pe);
            } else if (typeof pe === "number") {
                this.gen("(%s)", this.strRValue(asm.bindings[<number>pe]));
            } else
                assert(false, "unsupported pattern value "+ pe);
        }
        this.gen(";}\n");
    }

    private generateBinopOutofline (binop: BinOp): void
    {
        var callerStr: string = "&frame, ";
        this.gen("  %sjs::operator_%s(%s%s, %s);\n",
            this.strDest(binop.dest),
            oc2s(binop.op),
            callerStr,
            this.strRValue(binop.src1), this.strRValue(binop.src2)
        );
    }

    private strToNumber (rv: RValue): string
    {
        var callerStr: string = "&frame, ";
        if (isImmediate(rv)) {
            var n = Number(unwrapImmedate(rv));
            if (isNaN(n))
                return "NAN";
            else if (!isFinite(n))
                return n > 0 ? "INFINITY" : "-INFINITY";
            else
                return String(n);
        } else {
            return util.format("js::toNumber(%s%s)", callerStr, this.strRValue(rv));
        }
    }
    private strToInt32 (rv: RValue): string
    {
        var callerStr: string = "&frame, ";
        return isImmediate(rv) ?
            util.format("%d", unwrapImmedate(rv)|0) :
            util.format("js::toInt32(%s%s)", callerStr, this.strRValue(rv));
    }

    /**
     * Unwrap a value which we know is numeric
     * @param rv
     */
    private strUnwrapN (rv: RValue): string
    {
        return isImmediate(rv) ? String(unwrapImmedate(rv)) : util.format("%s.raw.nval", this.strRValue(rv));
    }

    private outNumericBinop (binop: BinOp, coper: string): void
    {
        this.gen("  %sjs::makeNumberValue(%s %s %s);\n", this.strDest(binop.dest),
            this.strToNumber(binop.src1), coper, this.strToNumber(binop.src2));
    }

    private outIntegerBinop (binop: BinOp, coper: string): void
    {
        this.gen("  %sjs::makeNumberValue(%s %s %s);\n", this.strDest(binop.dest),
            this.strToInt32(binop.src1), coper, this.strToInt32(binop.src2));
    }

    /**
     * A binary operator where we know the operands are numbers
     * @param binop
     * @param coper
     */
    private outBinop_N (binop: BinOp, coper: string): void
    {
        this.gen("  %sjs::makeNumberValue(%s %s %s);\n", this.strDest(binop.dest),
            this.strUnwrapN(binop.src1), coper, this.strUnwrapN(binop.src2));
    }

    private outNumericUnop (unop: UnOp, coper: string): void
    {
        this.gen("  %sjs::makeNumberValue(%s%s);\n", this.strDest(unop.dest),
            coper, this.strToNumber(unop.src1));
    }

    private outIntegerUnop (unop: UnOp, coper: string): void
    {
        this.gen("  %sjs::makeNumberValue(%s%s);\n", this.strDest(unop.dest),
            coper, this.strToInt32(unop.src1));
    }

    private generateBinop (binop: BinOp): void
    {
        var callerStr: string = "";
        if (binop.op === OpCode.ADD)
            callerStr = "&frame, ";

        switch (binop.op) {
            case OpCode.ADD:   this.generateBinopOutofline(binop); break;
            case OpCode.ADD_N: this.outNumericBinop(binop, "+"); break;
            case OpCode.SUB_N: this.outNumericBinop(binop, "-"); break;
            case OpCode.MUL_N: this.outNumericBinop(binop, "*"); break;
            case OpCode.DIV_N: this.outNumericBinop(binop, "/"); break;
            case OpCode.MOD_N:
                this.gen("  %sjs::makeNumberValue(fmod(%s, %s);\n", this.strDest(binop.dest),
                    this.strToNumber(binop.src1), this.strToNumber(binop.src2));
                break;
            case OpCode.SHL_N: this.outIntegerBinop(binop, "<<"); break;
            case OpCode.SHR_N:
                this.gen("  %sjs::makeNumberValue((uint32_t)%s %s (int32_t)%s);\n", this.strDest(binop.dest),
                    this.strToInt32(binop.src1), ">>", this.strToInt32(binop.src2));
                break;
            case OpCode.ASR_N: this.outIntegerBinop(binop, ">>"); break;
            case OpCode.OR_N: this.outIntegerBinop(binop, "|"); break;
            case OpCode.XOR_N: this.outIntegerBinop(binop, "^"); break;
            case OpCode.AND_N: this.outIntegerBinop(binop, "&"); break;

            default:
                this.generateBinopOutofline(binop);
                break;
        }
    }

    private generateUnop (unop: UnOp): void
    {
        switch (unop.op) {
            case OpCode.NEG_N: this.outNumericUnop(unop, "-"); break;
            case OpCode.LOG_NOT:
                this.gen("  %sjs::makeBooleanValue(!js::toBoolean(%s));\n", this.strDest(unop.dest), this.strRValue(unop.src1));
                break;
            case OpCode.BIN_NOT_N: this.outIntegerUnop(unop, "~"); break;
            case OpCode.TO_NUMBER:
                this.gen("  %sjs::makeNumberValue(%s);\n", this.strDest(unop.dest), this.strToNumber(unop.src1));
                break;
            default:
                assert(false, "Unsupported instruction "+ unop);
                break;
        }
    }

    private generateGet (getop: BinOp): void
    {
        var callerStr = "&frame, ";

        if (isString(getop.src2)) {
            var strName: string = <string>unwrapImmedate(getop.src2);

            // IMPORTANT: string property names looking like integer numbers must be treated as
            // computed properties
            if (!isNonNegativeInteger(strName)) {
                this.gen("  %sjs::get(%s%s, %s);\n",
                    this.strDest(getop.dest),
                    callerStr,
                    this.strRValue(getop.src1), this.strStringPrim(strName)
                );
                return;
            }
        }

        this.gen("  %sjs::getComputed(%s%s, %s);\n",
            this.strDest(getop.dest),
            callerStr,
            this.strRValue(getop.src1), this.strRValue(getop.src2)
        );
    }

    private generatePut (putop: PutOp): void
    {
        var callerStr = "&frame, ";

        if (isString(putop.propName)) {
            var strName: string = <string>unwrapImmedate(putop.propName);

            // IMPORTANT: string property names looking like integer numbers must be treated as
            // computed properties
            if (!isNonNegativeInteger(strName)) {
                this.gen("  js::put(%s%s, %s, %s);\n",
                    callerStr,
                    this.strRValue(putop.obj), this.strStringPrim(strName), this.strRValue(putop.src)
                );
                return;
            }
        }

        this.gen("  js::putComputed(%s%s, %s, %s);\n",
            callerStr,
            this.strRValue(putop.obj), this.strRValue(putop.propName), this.strRValue(putop.src)
        );
    }

    private outCallerLine(): void
    {
        if (this.module.debugMode)
            this.gen("  frame.setLine(__LINE__+1);\n");
    }

    private generateInst(inst: Instruction): void
    {
        switch (inst.op) {
            case OpCode.CLOSURE:
                var closureop = <ClosureOp>inst;
                this.outCallerLine();
                this.gen("  %sjs::newFunction(&frame, %s, %s, %d, %s);\n",
                    this.strDest(closureop.dest),
                    this.strEnvAccess(closureop.funcRef.lowestEnvAccessed),
                    closureop.funcRef.name ? this.strStringPrim(closureop.funcRef.name) : "NULL",
                    closureop.funcRef.params.length-1,
                    this.module.strFunc(closureop.funcRef)
                );
                break;
            case OpCode.CREATE: this.outCreate(<UnOp>inst); break;
            case OpCode.LOAD_SC: this.outLoadSC(<LoadSCOp>inst); break;
            case OpCode.ASM:    this.generateAsm(<AsmOp>inst); break;

            case OpCode.ASSIGN:
                var assignop = <AssignOp>inst;
                this.gen("  %s%s;\n", this.strDest(assignop.dest), this.strRValue(assignop.src1));
                break;
            case OpCode.GET: this.generateGet(<BinOp>inst); break;
            case OpCode.PUT: this.generatePut(<PutOp>inst); break;
            case OpCode.CALL:
                // TODO: self tail-recursion optimization
                var callop = <CallOp>inst;
                this.outCallerLine();
                this.gen("  %s%s(&frame, %s, %d, &%s);\n",
                    this.strDest(callop.dest),
                    this.module.strFunc(callop.fref),
                    this.strEnvAccess(callop.fref.lowestEnvAccessed),
                    callop.args.length,
                    this.strMemValue(callop.args[0])
                );
                break;
            case OpCode.CALLIND:
                var callop = <CallOp>inst;
                this.outCallerLine();
                this.gen("  js::call(&frame, %s, %d, &%s);\n",
                    this.strRValue(callop.closure),
                    callop.args.length,
                    this.strMemValue(callop.args[0])
                );
                break;
            default:
                if (inst.op >= OpCode._BINOP_FIRST && inst.op <= OpCode._BINOP_LAST) {
                    this.generateBinop(<BinOp>inst);
                } else if (inst.op >= OpCode._UNOP_FIRST && inst.op <= OpCode._UNOP_LAST) {
                    this.generateUnop(<UnOp>inst);
                }
                else {
                    assert(false, "Unsupported instruction "+ inst);
                }
                break;
        }
    }

    private strIfOpCond (ifop: IfOp): string
    {
        var callerStr: string = "&frame, ";
        var cond: string;
        switch (ifop.op) {
            case OpCode.IF_TRUE:
                cond = util.format("js::toBoolean(%s)", this.strRValue(ifop.src1));
                break;
            case OpCode.IF_IS_OBJECT:
                cond = util.format("js::isValueTagObject(%s.tag)", this.strRValue(ifop.src1));
                break;
            case OpCode.IF_STRICT_EQ:
                cond = util.format("operator_%s(%s, %s)",
                    oc2s(ifop.op), this.strRValue(ifop.src1), this.strRValue(ifop.src2)
                );
                break;
            case OpCode.IF_STRICT_NE:
                cond = util.format("!operator_%s(%s, %s)",
                    oc2s(OpCode.IF_STRICT_EQ), this.strRValue(ifop.src1), this.strRValue(ifop.src2)
                );
                break;

            default:
                if (ifop.op >= OpCode._BINCOND_FIRST && ifop.op <= OpCode._BINCOND_LAST) {
                    cond = util.format("operator_%s(%s%s, %s)",
                        oc2s(ifop.op), callerStr, this.strRValue(ifop.src1), this.strRValue(ifop.src2)
                    );
                } else {
                    cond = util.format("operator_%s(%s)", oc2s(ifop.op), this.strRValue(ifop.src1));
                }
                break;
        }
        return cond;
    }

    /**
     * Generate a jump instruction, taking care of the fall-through case.
     * @param inst
     * @param nextBB
     */
    private generateJump (inst: Instruction, nextBB: BasicBlock): void
    {
        var callerStr: string = "&frame, ";
        assert(inst instanceof JumpInstruction);
        var jump = <JumpInstruction>inst;

        var bb1 = jump.label1 && jump.label1.bb;
        var bb2 = jump.label2 && jump.label2.bb;

        if (jump.op === OpCode.GOTO) {
            if (bb1 !== nextBB)
            this.gen("  goto %s;\n", this.strBlock(bb1));
        }
        else if (jump.op >= OpCode._IF_FIRST && jump.op <= OpCode._IF_LAST) {
            var cond = this.strIfOpCond(<IfOp>jump);

            if (bb2 === nextBB)
                this.gen("  if (%s) goto %s;\n", cond, this.strBlock(bb1));
            else if (bb1 === nextBB)
                this.gen("  if (!%s) goto %s;\n", cond, this.strBlock(bb2));
            else
                this.gen("  if (%s) goto %s; else goto %s;\n", cond, this.strBlock(bb1), this.strBlock(bb2));
        }
        else if (jump.op === OpCode.RET) {
            var retop = <RetOp>jump;
            this.gen("  return %s;\n", this.strRValue(retop.src));
        }
        else
            assert(false, "unknown instructiopn "+ jump);
    }

    private _generateC (): void
    {
        var gen = this.gen.bind(this);
        gen("\n// %s\nstatic js::TaggedValue %s (js::StackFrame * caller, js::Env * env, unsigned argc, const js::TaggedValue * argv)\n{\n",
            this.name || "<unnamed>", this.module.strFunc(this)
        );
        gen("  js::StackFrameN<%d,%d,%d> frame(caller, env, __FILE__ \":%s\", __LINE__);\n\n",
            this.envSize, this.locals.length, this.paramSlotsCount,
            this.name || "<unnamed>"
        );

        // Keep track if the very last thing we generated was a label, so we can add a ';' after i
        // at the end
        var labelWasLast = false;
        for ( var bi = 0, be = this.blockList.length; bi < be; ++bi ) {
            var bb = this.blockList[bi];
            labelWasLast = bb.body.length === 0;
            gen("%s:\n", this.strBlock(bb));
            for ( var ii = 0, ie = bb.body.length-1; ii < ie; ++ii )
                this.generateInst(bb.body[ii]);

            if (ie >= 0)
                this.generateJump(bb.body[ii], bi < be - 1 ? this.blockList[bi+1] : null);
        }
        if (labelWasLast)
            gen("  ;\n");

        gen("}\n");
    }

    generateC (obuf: OutputSegment): void
    {
        if (this.isBuiltIn)
            return;
        this.obuf = obuf;
        try
        {
            this._generateC();
        }
        finally
        {
            this.obuf = null;
        }
    }
}

export class OutputSegment
{
    private obuf: string[] = [];

    public format (...params: any[]): void
    {
        this.obuf.push(util.format.apply(null, arguments));
    }
    public push (x: string): void
    {
        this.obuf.push(x);
    }

    public dump (out: NodeJS.WritableStream): void
    {
        for ( var i = 0, e = this.obuf.length; i < e; ++i )
            out.write(this.obuf[i]);
    }
}

export function escapeCString (s: string): string
{
    return escapeCStringBuffer(new Buffer(s, "utf8")).toString("ascii");
}

function max (a: number, b: number): number
{
    return a > b ? a : b;
}

function min (a: number, b: number): number
{
    return a < b ? a : b;
}

class DynBuffer
{
    buf: Buffer;
    length: number = 0;

    constructor (hint: number)
    {
        this.buf = new Buffer(hint);
    }

    reserve (extra: number, exactly: boolean): void
    {
        var rlen = this.length + extra;
        var newLength: number;

        if (!exactly) {
            if (rlen <= this.buf.length)
                return;
            newLength = max(this.buf.length * 2, rlen);
        } else {
            if (rlen === this.buf.length)
                return;
            newLength = rlen;
        }

        var old = this.buf;
        this.buf = new Buffer(newLength);
        old.copy(this.buf, 0, 0, this.length);
    }

    addBuffer (s: Buffer, from: number, to: number): void
    {
        this.reserve(to - from, false);
        s.copy(this.buf, this.length, from, to);
        this.length += to - from;
    }

    addASCIIString (s: string): void
    {
        this.reserve(s.length, false);

        var length = this.length;
        for ( var i = 0, e = s.length; i < e; ++i )
            this.buf[length++] = s.charCodeAt(i);
        this.length = length;
    }
}

export function escapeCStringBuffer (s: Buffer, from?: number, to?: number): Buffer
{
    if (from === void 0)
        from = 0;
    if (to === void 0)
        to = s.length;

    var res: DynBuffer = null;
    var lastIndex = from;

    for ( var i = from; i < to; ++i ) {
        var byte = s[i];
        if (byte < 32 || byte > 127) {
            if (!res)
                res = new DynBuffer(to - from + 16);
            if (lastIndex < i)
                res.addBuffer(s, lastIndex, i);
            lastIndex = i + 1;
            switch (byte) { // TODO: more escapes
                case 9:  res.addASCIIString("\\t"); break;
                case 10: res.addASCIIString("\\n"); break;
                case 13: res.addASCIIString("\\r"); break;
                default: res.addASCIIString(util.format("\\%d%d%d", byte/64&7, byte/8&7, byte&7)); break;
            }
        }
    }
    if (res !== null) {
        res.reserve(i - lastIndex, true)
        if (lastIndex < i)
            res.addBuffer(s, lastIndex, i);
        return res.buf;
    }
    else {
        if (from !== 0 || to !== s.length)
            return s.slice(from, to);
        else
            return s;
    }
}


function bufferIndexOf (haystack: Buffer, haystackLen: number, needle: Buffer, startIndex: number = 0): number
{
    // TODO: full Boyer-Moore, etc
    // see http://stackoverflow.com/questions/3183582/what-is-the-fastest-substring-search-algorithm
    var needleLen = needle.length;

    // Utilize Boyer-Moore-Harspool for needles much smaller than the haystack
    if (needleLen >= 8 && haystackLen - startIndex - needleLen > 1000)
        return bmh.search(haystack, startIndex, haystackLen, needle);

    for ( var i = 0, e = haystackLen - needleLen + 1; i < e; ++i ) {
        var j: number;
        for ( j = 0; j < needleLen && haystack[i+j] === needle[j]; ++j )
        {}
        if (j === needleLen)
            return i;
    }
    return -1;
}

export class ModuleBuilder
{
    private nextFunctionId = 0;
    private topLevel: FunctionBuilder = null;

    /** Headers added with the __asmh__ compiler extension */
    private asmHeaders : string[] = [];
    private asmHeadersSet = new StringMap<Object>();
    private strings : string[] = [];
    private stringMap = new StringMap<number>();
    private codeSeg = new OutputSegment();

    public debugMode: boolean = false;

    constructor(debugMode: boolean)
    {
        this.debugMode = debugMode;
    }

    addAsmHeader (h: string) {
        if (!this.asmHeadersSet.has(h)) {
            this.asmHeadersSet.set(h, null);
            this.asmHeaders.push(h);
        }
    }

    addString (s: string): number {
        var n: number;
        if ( (n = this.stringMap.get(s)) === void 0) {
            n = this.strings.length;
            this.strings.push(s);
            this.stringMap.set(s, n);
        }
        return n;
    }

    newFunctionId (): number
    {
        return this.nextFunctionId++;
    }

    createTopLevel(): FunctionBuilder
    {
        assert(!this.topLevel);
        var fref = new FunctionBuilder(this.newFunctionId(), this, null, null, "<global>");
        this.topLevel = fref;
        return fref;
    }

    prepareForCodegen (): void
    {
        this.topLevel.prepareForCodegen();
    }

    strFunc (fref: FunctionBuilder): string
    {
        return fref.mangledName;
    }

    private gen (...params: any[])
    {
        this.codeSeg.push(util.format.apply(null, arguments));
    }

    private outputStringStorage (out: NodeJS.WritableStream): void
    {
        if (!this.strings.length)
            return;
        /* TODO: to generalized suffix tree mapping.
          Something like this?
          - sort strings in decreasing length
          - start with an empty string buffer
          - for each string
             - if found in the string buffer use that position
             - append to the string buffer
        */
        var index: number[] = new Array<number>(this.strings.length);
        var offsets: number[] = new Array<number>(this.strings.length);
        var lengths: number[] = new Array<number>(this.strings.length);

        // Sort the strings in decreasing length
        var e = this.strings.length;
        var i : number;
        var totalLength = 0; // the combined length of all strings as initial guess for our buffer
        for ( i = 0; i < e; ++i ) {
            index[i] = i;
            totalLength += this.strings[i].length;
        }

        index.sort( (a: number, b:number) => this.strings[b].length - this.strings[a].length);

        var buf = new DynBuffer(totalLength);

        for ( i = 0; i < e; ++i ) {
            var ii = index[i];
            var s = this.strings[ii];
            var encoded = new Buffer(s, "utf8");
            var pos: number = bufferIndexOf(buf.buf, buf.length, encoded);

            if (pos < 0) { // Append to the buffer
                pos = buf.length;
                buf.addBuffer(encoded, 0, encoded.length);
            }

            offsets[ii] = pos;
            lengths[ii] = encoded.length;
        }

        out.write(util.format("static const js::StringPrim * s_strings[%d];\n", this.strings.length));
        out.write("static const char s_strconst[] =\n");
        var line: string;
        var margin = 72;

        for ( var ofs = 0; ofs < buf.length; )
        {
            var to = min(buf.length, ofs + margin);
            line = "  \"" + escapeCStringBuffer(buf.buf, ofs, to) + "\"";
            if (to == buf.length)
                line += ";";
            line += "\n";
            out.write(line);
            ofs = to;
        }

        line = util.format("static const unsigned s_strofs[%d] = {", this.strings.length*2);

        for ( var i = 0; i < this.strings.length; ++i ) {
            var t = util.format("%d,%d", offsets[i], lengths[i]);
            if (line.length + t.length + 1 > margin) {
                out.write(line += i > 0 ? ",\n" : "\n");
                line = "  "+t;
            } else {
                line += i > 0 ? "," + t : t;
            }
        }
        line += "};\n\n";
        out.write(line);
    }

    generateC (out: NodeJS.WritableStream): void
    {
        var moduleFunc = this.topLevel.closures[0];

        var forEachFunc = (fb: FunctionBuilder, cb: (fb: FunctionBuilder)=>void) => {
            if (fb !== this.topLevel)
                cb(fb);
            fb.closures.forEach((fb) => forEachFunc(fb, cb));
        };

        forEachFunc(this.topLevel, (fb) => {
            if (!fb.isBuiltIn)
                this.gen("static js::TaggedValue %s (js::StackFrame*, js::Env*, unsigned, const js::TaggedValue*); // %s\n",
                    this.strFunc(fb), fb.name || "<unnamed>"
                );
        });
        this.gen("\n");
        forEachFunc(this.topLevel, (fb) => fb.generateC(this.codeSeg));

        this.gen(
`
int main()
{
    js::g_runtime = new js::Runtime();
    js::StackFrameN<0, 1, 0> frame(NULL, NULL, __FILE__ ":main", __LINE__);
`
        );
        if (this.strings.length > 0) {
            this.gen(util.format(
                "    JS_GET_RUNTIME(&frame)->initStrings(&frame, s_strings, s_strconst, s_strofs, %d);",
                this.strings.length
            ));
        }

        this.gen(
`
    frame.setLine(__LINE__+1);
    frame.locals[0] = js::makeObjectValue(new(&frame) js::Object(JS_GET_RUNTIME(&frame)->objectPrototype));
    frame.setLine(__LINE__+1);
    ${this.topLevel.closures[0].mangledName}(&frame, JS_GET_RUNTIME(&frame)->env, 1, frame.locals);

    if (JS_GET_RUNTIME(&frame)->diagFlags & (js::Runtime::DIAG_HEAP_GC | js::Runtime::DIAG_FORCE_GC))
        js::forceGC(&frame);

    return 0;
}`
        );

        out.write(util.format("#include <jsc/runtime.h>\n"));
        // Generate the headers added with __asmh__
        this.asmHeaders.forEach((h: string) => out.write(util.format("%s\n", h)));
        out.write("\n");

        this.outputStringStorage(out);

        this.codeSeg.dump(out);
    }
}
