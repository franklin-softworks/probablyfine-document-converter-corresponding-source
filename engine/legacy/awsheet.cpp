// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// Apple II AppleWorks spreadsheet and database readers: a port of the ASP and ADB reformatters of CiderPress (reformat/AppleWorks.cpp), Copyright (c) 2007
// faddenSoft, LLC, under the BSD-3-Clause licence (web/licenses/COPYING.CIDERPRESS). What is ported is the file-format knowledge; the code is new: it writes
// OpenDocument flat XML instead of CSV, and every length read from the file is checked against what is left of the file.
//
// What is measured on the real files (10 ASP and 10 ADB from the owner's sample, in a sandbox without a network; numbers only): in every ASP the row length field
// counts exactly the bytes after it up to the row's $FF; every ADB has one record more than the header's count (the first is the "standard values" record,
// CiderPress's loop skips it and so drops the last data record: here every data record is kept) and ends at the $FFFF marker with nothing after it.
#include "awsheet.hpp"
#include <cmath>
#include <cstdio>
#include <cstring>

namespace
{
const size_t kMaxOutput = 96u << 20;      // a conversion that would write more than this is refused, not cut
const uint32_t kMaxRow = 65535;           // AppleWorks counts rows to 999 (3.0: 9999); the field is 16 bits
const unsigned kMaxCol = 127;             // the header has a width byte for 127 columns
const size_t kAspHeader = 300;

inline unsigned le16(const uint8_t *p) { return p[0] | (p[1] << 8); }

void xmlText(std::string &o, const char *s, size_t n)
{
    for (size_t i = 0; i < n; ++i)
    {
        unsigned char c = static_cast<unsigned char>(s[i]);
        switch (c)
        {
        case '&': o += "&amp;"; break;
        case '<': o += "&lt;"; break;
        case '>': o += "&gt;"; break;
        case '"': o += "&quot;"; break;
        default: o += static_cast<char>(c);
        }
    }
}

// an Apple II text byte as printable ASCII: the high bit is the "inverse/flash" attribute, not part of the character; controls become spaces
char apple(uint8_t b)
{
    b &= 0x7F;
    return (b < 0x20 || b == 0x7F) ? ' ' : static_cast<char>(b);
}

const char *kHead =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    "<office:document xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" "
    "xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\" "
    "xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\" office:version=\"1.2\" office:mimetype=\"application/vnd.oasis.opendocument.spreadsheet\">"
    "<office:automatic-styles>"
    "<style:style style:name=\"co1\" style:family=\"table-column\"><style:table-column-properties style:use-optimal-column-width=\"true\"/></style:style>"
    "<style:style style:name=\"hd\" style:family=\"table-cell\"><style:text-properties fo:font-weight=\"bold\"/></style:style>"
    "</office:automatic-styles><office:body><office:spreadsheet><table:table table:name=\"";

void cellString(std::string &o, const char *s, size_t n, bool header = false)
{
    o += "<table:table-cell";
    if (header) o += " table:style-name=\"hd\"";
    o += " office:value-type=\"string\"><text:p>";
    xmlText(o, s, n);
    o += "</text:p></table:table-cell>";
}

void cellNumber(std::string &o, double v)
{
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.15g", v);
    o += "<table:table-cell office:value-type=\"float\" office:value=\"";
    o += buf;
    o += "\"><text:p>";
    o += buf;
    o += "</text:p></table:table-cell>";
}

void emptyCells(std::string &o, unsigned n)
{
    if (n == 0) return;
    o += "<table:table-cell";
    if (n > 1) { o += " table:number-columns-repeated=\""; o += std::to_string(n); o += "\""; }
    o += "/>";
}

// ---------------------------------------------------------------------------------------------------------------------------------- ASP

bool aspHeaderOk(const uint8_t *d, size_t n)
{
    if (n < kAspHeader + 2) return false;
    const uint8_t order = d[131], freq = d[132], win = d[136], vers = d[242];
    return (order == 'R' || order == 'C') && (freq == 'A' || freq == 'M') && (win == '1' || win == 'S' || win == 'T') && (vers == 0 || vers == 0x1E);
}

// the cell's text or number into `row`; returns false when the cell is damaged
bool aspCell(std::string &row, const uint8_t *c, size_t len, unsigned col, const uint8_t *colWidth)
{
    if (len < 1) return false;
    const uint8_t f1 = c[0];
    if (f1 & 0x80)
    {
        if (len < 2) return false;
        const uint8_t f2 = c[1];
        const uint8_t *p = c + 2;
        size_t left = len - 2;
        if (f1 & 0x20)   // value constant: an 8-byte SANE double
        {
            if (left < 8) return false;
            double v;
            std::memcpy(&v, p, 8);
            if (std::isfinite(v)) cellNumber(row, v); else cellString(row, "#ERROR", 6);
        }
        else if (f2 & 0x08)   // AppleWorks 3.0 "value label": a cached string, then the formula tokens (not carried)
        {
            if (left < 1 || p[0] >= left) return false;
            std::string s;
            for (size_t i = 0; i < p[0]; ++i) s += apple(p[1 + i]);
            cellString(row, s.data(), s.size());
        }
        else   // a formula: an 8-byte cached result, then the tokens (not carried: the last calculated value is)
        {
            if (left <= 8) return false;
            double v;
            std::memcpy(&v, p, 8);
            if (std::isfinite(v)) cellNumber(row, v); else cellString(row, "#ERROR", 6);
        }
        return true;
    }
    std::string s;
    if (f1 & 0x20)   // a propagated label: one character repeated to fill the column
    {
        if (len < 2) return false;
        unsigned w = col < kMaxCol ? colWidth[col] : 0;
        if (w == 0 || w > 80) w = 8;
        s.assign(w, apple(c[1]));
    }
    else
    {
        for (size_t i = 1; i < len; ++i) s += apple(c[i]);
    }
    cellString(row, s.data(), s.size());
    return true;
}

int aspRun(const uint8_t *d, size_t n, std::string *out)
{
    if (!aspHeaderOk(d, n)) return 3;
    const uint8_t *colWidth = d + 4;   // 127 bytes: the width of each column in characters
    size_t off = kAspHeader + (d[242] != 0 ? 2 : 0);
    std::string body;
    unsigned prevRow = 0, maxCol = 1;
    for (;;)
    {
        if (off + 2 > n) return 3;
        const unsigned rowLen = le16(d + off);
        if (rowLen == 0xFFFF) break;
        if (off + 4 > n) return 3;
        const unsigned rowNum = le16(d + off + 2);
        if (rowNum < 1 || rowNum > kMaxRow || rowNum <= prevRow) return 3;
        // the row record: rowLen counts the bytes after the length field, up to and including the row's $FF
        const size_t end = off + 2 + rowLen;
        if (rowLen < 3 || end > n || d[end - 1] != 0xFF) return 3;
        std::string row;
        unsigned col = 0;
        for (size_t p = off + 4; p < end;)
        {
            const uint8_t ctrl = d[p++];
            if (ctrl == 0xFF)
            {
                if (p != end) return 3;
                break;
            }
            if (ctrl >= 0x01 && ctrl <= 0x7F)
            {
                if (p + ctrl > end - 1 || col >= kMaxCol) return 3;
                if (!aspCell(row, d + p, ctrl, col, colWidth)) return 3;
                p += ctrl;
                ++col;
            }
            else if (ctrl >= 0x81 && ctrl <= 0xFE)
            {
                const unsigned skip = ctrl - 0x80;
                if (col + skip > kMaxCol) return 3;
                emptyCells(row, skip);
                col += skip;
            }
            else return 3;
        }
        if (col > maxCol) maxCol = col;
        if (out)
        {
            if (rowNum > prevRow + 1)
            {
                body += "<table:table-row";
                if (rowNum - prevRow - 1 > 1) { body += " table:number-rows-repeated=\""; body += std::to_string(rowNum - prevRow - 1); body += "\""; }
                body += "><table:table-cell/></table:table-row>";
            }
            body += "<table:table-row>";
            body += row;
            body += "</table:table-row>";
            if (body.size() > kMaxOutput) return 3;
        }
        prevRow = rowNum;
        off = end;
    }
    if (out)
    {
        out->clear();
        *out += kHead;
        *out += "Sheet1\"><table:table-column table:style-name=\"co1\" table:number-columns-repeated=\"";
        *out += std::to_string(maxCol);
        *out += "\"/>";
        *out += body;
        *out += "</table:table></office:spreadsheet></office:body></office:document>\n";
    }
    return 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------- ADB

const size_t kAdbCatTable = 357, kAdbCatLen = 22, kAdbCatName = 20, kAdbReportLen = 600, kAdbMinHeader = 379;

struct AdbHead { unsigned cats, recs, reps; size_t dataOff; };

// The header's SHAPE: what makes a file an AppleWorks database. A file cut short is still recognised (so it is refused as damaged, never handed to the other
// libraries); the name slots that are not in the file are not judged, and adbRun refuses the file.
bool adbShape(const uint8_t *d, size_t n, AdbHead &h)
{
    if (n <= kAdbMinHeader) return false;
    const unsigned hl = le16(d);
    if (hl < kAdbMinHeader) return false;
    h.cats = d[35];
    h.recs = le16(d + 36) & 0x7FFF;
    h.reps = d[38];
    if (h.cats < 1 || h.cats > 30 || h.reps > 30) return false;
    h.dataOff = kAdbCatTable + h.cats * kAdbCatLen + h.reps * kAdbReportLen;
    // every category name present in the file: at most 20 characters, all printable (the high bit is an Apple II display attribute), the first one not empty
    for (unsigned i = 0; i < h.cats; ++i)
    {
        const size_t slot = kAdbCatTable + i * kAdbCatLen;
        if (slot >= n) break;
        const uint8_t len = d[slot];
        if (len > kAdbCatName || (i == 0 && len == 0)) return false;
        for (unsigned k = 0; k < len && slot + 1 + k < n; ++k)
        {
            const uint8_t ch = d[slot + 1 + k] & 0x7F;
            if (ch < 0x20 || ch > 0x7E) return false;
        }
    }
    return true;
}

bool adbHeader(const uint8_t *d, size_t n, AdbHead &h)
{
    if (!adbShape(d, n, h)) return false;
    return le16(d) <= n && h.dataOff + 4 <= n;
}

int adbRun(const uint8_t *d, size_t n, std::string *out)
{
    AdbHead h;
    if (!adbHeader(d, n, h)) return 3;
    // the record chain: the standard-values record, then `recs` data records, then $FFFF
    std::string body;
    size_t p = h.dataOff;
    unsigned walked = 0;
    for (;;)
    {
        if (p + 2 > n) return 3;
        const unsigned rem = le16(d + p);
        if (rem == 0xFFFF) { p += 2; break; }
        p += 2;
        const size_t end = p + rem;
        if (rem < 1 || end > n || d[end - 1] != 0xFF) return 3;
        if (walked > h.recs) return 3;   // more records than the header says
        if (walked > 0)
        {
            std::string row;
            unsigned col = 0;
            for (size_t q = p; q < end;)
            {
                const uint8_t ctrl = d[q++];
                if (ctrl == 0xFF) { if (q != end) return 3; break; }
                if (ctrl >= 0x01 && ctrl <= 0x7F)
                {
                    if (q + ctrl > end - 1 || col >= h.cats) return 3;
                    const uint8_t *f = d + q;
                    std::string s;
                    if (ctrl == 6 && f[0] == 0xC0)   // a date: C0 y y m d d (month 'A'..'L')
                    {
                        static const char *const kMon[12] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
                        const char dd0 = f[4] == ' ' ? '0' : apple(f[4]);
                        s += dd0; s += apple(f[5]); s += '-';
                        s += (f[3] >= 'A' && f[3] <= 'L') ? kMon[f[3] - 'A'] : "???";
                        s += '-'; s += f[1] < '7' ? "20" : "19"; s += apple(f[1]); s += apple(f[2]);
                    }
                    else if (ctrl == 4 && f[0] == 0xD4 && f[1] >= 'A' && f[1] <= 'X')   // a time: D4 hour(letter) m m
                    {
                        const bool pm = f[1] >= 'M';
                        int hr = pm ? f[1] - 'M' : f[1] - 'A';
                        if (hr == 0) hr = 12;
                        char t[24];
                        std::snprintf(t, sizeof(t), "%02d:%c%c %s", hr, apple(f[2]), apple(f[3]), pm ? "PM" : "AM");
                        s = t;
                    }
                    else for (unsigned i = 0; i < ctrl; ++i) s += apple(f[i]);
                    cellString(row, s.data(), s.size());
                    q += ctrl;
                    ++col;
                }
                else if (ctrl >= 0x81 && ctrl <= 0x9E)
                {
                    const unsigned skip = ctrl - 0x80;
                    if (col + skip > h.cats) return 3;
                    emptyCells(row, skip);
                    col += skip;
                }
                else return 3;
            }
            if (out)
            {
                if (col < h.cats) emptyCells(row, h.cats - col);
                body += "<table:table-row>"; body += row; body += "</table:table-row>";
                if (body.size() > kMaxOutput) return 3;
            }
        }
        p = end;
        ++walked;
    }
    if (walked != h.recs + 1) return 3;   // the header's count is of data records, the standard-values record comes first
    if (out)
    {
        out->clear();
        *out += kHead;
        *out += "Data\"><table:table-column table:style-name=\"co1\" table:number-columns-repeated=\"";
        *out += std::to_string(h.cats);
        *out += "\"/><table:table-row>";
        for (unsigned i = 0; i < h.cats; ++i)
        {
            const uint8_t *c = d + kAdbCatTable + i * kAdbCatLen;
            std::string s;
            for (unsigned k = 0; k < c[0]; ++k) s += apple(c[1 + k]);
            cellString(*out, s.data(), s.size(), true);
        }
        *out += "</table:table-row>";
        *out += body;
        *out += "</table:table></office:spreadsheet></office:body></office:document>\n";
    }
    return 0;
}
}

// Detection is by the HEADER's structure; a file with such a header that cannot be read to its end marker is then a DAMAGED AppleWorks file (convert answers 3), not
// an unknown one: left to the other libraries it could be mistaken for something else (libwpd's weak heuristics take a zero-padded fragment for WordPerfect).
bool asp_detect(const uint8_t *d, size_t n) { return aspHeaderOk(d, n); }
bool adb_detect(const uint8_t *d, size_t n) { AdbHead h; return adbShape(d, n, h); }
int asp_convert(const uint8_t *d, size_t n, std::string &out) { return aspRun(d, n, &out); }
int adb_convert(const uint8_t *d, size_t n, std::string &out) { return adbRun(d, n, &out); }
