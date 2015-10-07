// Copyright (c) 2015 Tzvetan Mikov.
// Licensed under the Apache License v2.0. See LICENSE in the project
// root for complete license information.

#include "jsc/jsimpl.h"

#include <algorithm>

namespace js {

void StringBuilder::growTo (StackFrame * caller, size_t minSize)
{
    size_t newCap = std::max(m_cap << 1, minSize);
    if (newCap < m_cap)
        throwOutOfMemory(caller);
    if (unsigned char * newBuf = (unsigned char *)realloc(m_buf, newCap)) {
        m_buf = newBuf;
        m_cap = newCap;
    } else {
        throwOutOfMemory(caller);
    }
}

const StringPrim * StringBuilder::toStringPrim (StackFrame * caller) const
{
    StackFrameN<0,1,0> frame(caller, NULL, __FILE__ ":StringBuilder::toStringPrim()", __LINE__);
    StringPrim * s;
    frame.locals[0] = makeStringValue(s = StringPrim::makeEmpty(&frame, m_len));
    memcpy(s->_str, m_buf, m_len);
    s->init();
    return s;
}

void StringBuilder::reverse (size_t begin, size_t end)
{
    if (begin != end) {
        unsigned char * b = m_buf + begin;
        unsigned char * e = m_buf + end;
        --e;
        while (b < e) {
            unsigned char t = *b;
            *b = *e;
            *e = t;
            ++b;
            --e;
        }
    }
}

}; // namespace js
