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
#include <vector>

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

// The document head up to the automatic styles; the styles the cells use (number formats, alignment) are written after it, then kHeadEnd.
const char *kHeadStart =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    "<office:document xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" "
    "xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\" "
    "xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\" xmlns:number=\"urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0\" "
    "office:version=\"1.2\" office:mimetype=\"application/vnd.oasis.opendocument.spreadsheet\">"
    "<office:automatic-styles>"
    "<style:style style:name=\"co1\" style:family=\"table-column\"><style:table-column-properties style:use-optimal-column-width=\"true\"/></style:style>"
    "<style:style style:name=\"hd\" style:family=\"table-cell\"><style:text-properties fo:font-weight=\"bold\"/></style:style>";
const char *kHeadEnd = "</office:automatic-styles><office:body><office:spreadsheet><table:table table:name=\"";

// What a cell shows. AppleWorks' number formats (file type note $1B): 2 fixed, 3 dollars, 4 commas, 5 percent, each with 0-7 decimals; 6 "appropriate" and the
// spreadsheet standard are left to the General format. Alignment: 2 left, 3 right, 4 centered (a label's default is left; a value's, right).
struct CellLook
{
    uint8_t kind = 0;        // 0 general, 2 fixed, 3 dollars, 4 commas, 5 percent
    uint8_t dec = 0;         // decimals
    bool blankZero = false;  // a constant that shows nothing when it is zero
    uint8_t align = 0;       // 0 the cell's own default, 3 right, 4 centered
    uint32_t key() const { return (static_cast<uint32_t>(kind) << 16) | (static_cast<uint32_t>(dec) << 8) | (blankZero ? 0x10u : 0u) | align; }
};

// the distinct looks of one document -> automatic styles "c0", "c1", ... (written once, after all cells are known)
class Looks
{
public:
    std::string name(const CellLook &l)
    {
        const uint32_t k = l.key();
        if (k == 0) return std::string();
        for (size_t i = 0; i < keys_.size(); ++i)
            if (keys_[i] == k) return "c" + std::to_string(i);
        keys_.push_back(k);
        return "c" + std::to_string(keys_.size() - 1);
    }
    void emit(std::string &o) const
    {
        bool anyBlank = false;
        std::vector<uint32_t> done;
        for (uint32_t k : keys_) if (k & 0x10u) anyBlank = true;
        if (anyBlank) o += "<number:number-style style:name=\"nz\"><number:text></number:text></number:number-style>";
        for (uint32_t k : keys_)
        {
            const unsigned kind = (k >> 16) & 7, dec = (k >> 8) & 7;
            const bool blank = (k & 0x10u) != 0;
            const uint32_t dk = k & ~0x0Fu;   // the data style depends on kind, decimals and blank, not on alignment
            bool seen = false;
            for (uint32_t d : done) if (d == dk) seen = true;
            if (seen || (kind == 0 && !blank)) continue;
            done.push_back(dk);
            const std::string nm = dataName(k);
            const std::string num = std::string("<number:number") + (kind == 0 ? "" : " number:decimal-places=\"" + std::to_string(dec) + "\"") + " number:min-integer-digits=\"1\"" +
                                    ((kind == 3 || kind == 4) ? " number:grouping=\"true\"" : "") + "/>";
            const std::string map = blank ? "<style:map style:condition=\"value()=0\" style:apply-style-name=\"nz\"/>" : "";
            if (kind == 3) o += "<number:currency-style style:name=\"" + nm + "\"><number:currency-symbol number:language=\"en\" number:country=\"US\">$</number:currency-symbol>" + num + map + "</number:currency-style>";
            else if (kind == 5) o += "<number:percentage-style style:name=\"" + nm + "\">" + num + "<number:text>%</number:text>" + map + "</number:percentage-style>";
            else o += "<number:number-style style:name=\"" + nm + "\">" + num + map + "</number:number-style>";
        }
        for (size_t i = 0; i < keys_.size(); ++i)
        {
            const uint32_t k = keys_[i];
            const unsigned kind = (k >> 16) & 7, align = k & 0x0F;
            o += "<style:style style:name=\"c" + std::to_string(i) + "\" style:family=\"table-cell\"";
            if (kind != 0 || (k & 0x10u)) o += " style:data-style-name=\"" + dataName(k) + "\"";
            o += ">";
            if (align == 3 || align == 4) o += "<style:table-cell-properties style:text-align-source=\"fix\"/><style:paragraph-properties fo:text-align=\"" + std::string(align == 3 ? "end" : "center") + "\"/>";
            o += "</style:style>";
        }
    }
private:
    static std::string dataName(uint32_t k) { return "n" + std::to_string((k >> 16) & 7) + std::to_string((k >> 8) & 7) + ((k & 0x10u) ? "z" : ""); }
    std::vector<uint32_t> keys_;
};

void cellString(std::string &o, const char *s, size_t n, bool header = false, const std::string &style = std::string())
{
    o += "<table:table-cell";
    if (header) o += " table:style-name=\"hd\"";
    else if (!style.empty()) o += " table:style-name=\"" + style + "\"";
    o += " office:value-type=\"string\"><text:p>";
    xmlText(o, s, n);
    o += "</text:p></table:table-cell>";
}

void cellNumber(std::string &o, double v, const std::string &style = std::string())
{
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.15g", v);
    o += "<table:table-cell";
    if (!style.empty()) o += " table:style-name=\"" + style + "\"";
    o += " office:value-type=\"float\" office:value=\"";
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

// The header's standard formats (file type note $1B, offsets 138-140 of the first window): what a cell whose own format is "spreadsheet standard" shows.
struct AspStd { uint8_t labelAlign; uint8_t valueFmt; uint8_t valueDec; };

AspStd aspStd(const uint8_t *d)
{
    AspStd s;
    s.labelAlign = (d[138] >= 2 && d[138] <= 4) ? d[138] : 2;
    s.valueFmt = (d[139] >= 2 && d[139] <= 6) ? d[139] : 6;
    s.valueDec = d[140] <= 7 ? d[140] : 0;
    return s;
}

// a label's alignment: 1 = the header's standard, 2 left, 3 right, 4 centered; left needs no style (a string is left by default)
uint8_t labelAlign(uint8_t bits, const AspStd &st)
{
    unsigned a = bits & 7;
    if (a < 2 || a > 4) a = st.labelAlign;
    return a == 2 ? 0 : static_cast<uint8_t>(a);
}

// a value's number format: byte 0 bits 2-0 (1 = the header's standard), the decimals in byte 1 bits 2-0
CellLook valueLook(uint8_t f1, uint8_t f2, bool isConstant, const AspStd &st)
{
    CellLook l;
    unsigned fmt = f1 & 7, dec = f2 & 7;
    if (fmt < 2 || fmt > 6) { fmt = st.valueFmt; dec = st.valueDec; }
    if (fmt >= 2 && fmt <= 5) { l.kind = static_cast<uint8_t>(fmt); l.dec = static_cast<uint8_t>(dec); }
    l.blankZero = isConstant && (f1 & 0x40) != 0;
    return l;
}

// the cell's text or number into `row`; returns false when the cell is damaged
bool aspCell(std::string &row, const uint8_t *c, size_t len, unsigned col, const uint8_t *colWidth, const AspStd &st, Looks &looks)
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
            if (std::isfinite(v)) cellNumber(row, v, looks.name(valueLook(f1, f2, true, st))); else cellString(row, "#ERROR", 6);
        }
        else if (f2 & 0x08)   // AppleWorks 3.0 "value label": a cached string, then the formula tokens (not carried)
        {
            if (left < 1 || p[0] >= left) return false;
            std::string s;
            for (size_t i = 0; i < p[0]; ++i) s += apple(p[1 + i]);
            CellLook l;
            l.align = labelAlign(f1, st);
            cellString(row, s.data(), s.size(), false, looks.name(l));
        }
        else   // a formula: an 8-byte cached result, then the tokens (not carried: the last calculated value is)
        {
            if (left <= 8) return false;
            double v;
            std::memcpy(&v, p, 8);
            if (std::isfinite(v)) cellNumber(row, v, looks.name(valueLook(f1, f2, false, st))); else cellString(row, "#ERROR", 6);
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
        cellString(row, s.data(), s.size());
        return true;
    }
    for (size_t i = 1; i < len; ++i) s += apple(c[i]);
    CellLook l;
    l.align = labelAlign(f1, st);
    cellString(row, s.data(), s.size(), false, looks.name(l));
    return true;
}

int aspRun(const uint8_t *d, size_t n, std::string *out)
{
    if (!aspHeaderOk(d, n)) return 3;
    const uint8_t *colWidth = d + 4;   // 127 bytes: the width of each column in characters
    const AspStd st = aspStd(d);
    Looks looks;
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
                if (!aspCell(row, d + p, ctrl, col, colWidth, st, looks)) return 3;
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
        *out += kHeadStart;
        looks.emit(*out);
        *out += kHeadEnd;
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

// One database field as the record holds it. A date and a time have their own marker bytes in the file; everything else is text.
struct AdbCell
{
    enum Kind : uint8_t { Empty, Text, Date, Time } kind = Empty;
    std::string text;        // what the field shows (a date as dd-Mon-yyyy, a time as hh:mm AM/PM); never changed by typing
    int a = 0, b = 0, c = 0; // Date: year, month, day; Time: hour (0-23), minute
    bool typed = false;      // a Date or Time whose parts are a real date or time (otherwise it stays text)
};

// A number as AppleWorks stores it (text): only a canonical decimal, so that typing it can never change what the field says (no leading zero, plus sign,
// separators or exponent, at most 15 digits: an id such as 007 or a long account number stays text). *decimals = digits after the point.
bool adbCanonicalNumber(const std::string &t, unsigned *decimals)
{
    size_t i = 0;
    if (i < t.size() && t[i] == '-') ++i;
    const size_t intStart = i;
    while (i < t.size() && t[i] >= '0' && t[i] <= '9') ++i;
    const size_t intLen = i - intStart;
    if (intLen == 0 || (intLen > 1 && t[intStart] == '0')) return false;
    size_t frac = 0;
    if (i < t.size())
    {
        if (t[i] != '.') return false;
        ++i;
        const size_t f0 = i;
        while (i < t.size() && t[i] >= '0' && t[i] <= '9') ++i;
        frac = i - f0;
        if (frac == 0) return false;
    }
    if (i != t.size() || intLen + frac > 15) return false;
    if (t[0] == '-' && intLen == 1 && t[intStart] == '0') { bool allZero = true; for (size_t k = intStart; k < t.size(); ++k) if (t[k] != '0' && t[k] != '.') allZero = false; if (allZero) return false; }
    *decimals = static_cast<unsigned>(frac);
    return true;
}

int adbRun(const uint8_t *d, size_t n, std::string *out)
{
    AdbHead h;
    if (!adbHeader(d, n, h)) return 3;
    // the record chain: the standard-values record, then `recs` data records, then $FFFF
    std::vector<std::vector<AdbCell>> recs;
    size_t cellBytes = 0;
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
            std::vector<AdbCell> row(h.cats);
            unsigned col = 0;
            for (size_t q = p; q < end;)
            {
                const uint8_t ctrl = d[q++];
                if (ctrl == 0xFF) { if (q != end) return 3; break; }
                if (ctrl >= 0x01 && ctrl <= 0x7F)
                {
                    if (q + ctrl > end - 1 || col >= h.cats) return 3;
                    const uint8_t *f = d + q;
                    AdbCell &cell = row[col];
                    std::string s;
                    if (ctrl == 6 && f[0] == 0xC0)   // a date: C0 y y m d d (month 'A'..'L')
                    {
                        static const char *const kMon[12] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
                        const char dd0 = f[4] == ' ' ? '0' : apple(f[4]);
                        s += dd0; s += apple(f[5]); s += '-';
                        s += (f[3] >= 'A' && f[3] <= 'L') ? kMon[f[3] - 'A'] : "???";
                        s += '-'; s += f[1] < '7' ? "20" : "19"; s += apple(f[1]); s += apple(f[2]);
                        cell.kind = AdbCell::Date;
                        const auto dig = [](uint8_t c) { return c >= '0' && c <= '9'; };
                        const uint8_t d0 = f[4] == ' ' ? '0' : f[4];
                        if (dig(f[1]) && dig(f[2]) && f[3] >= 'A' && f[3] <= 'L' && dig(d0) && dig(f[5]))
                        {
                            cell.a = (f[1] < '7' ? 2000 : 1900) + (f[1] - '0') * 10 + (f[2] - '0');
                            cell.b = f[3] - 'A' + 1;
                            cell.c = (d0 - '0') * 10 + (f[5] - '0');
                            static const int kDays[12] = { 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
                            cell.typed = cell.c >= 1 && cell.c <= kDays[cell.b - 1] && !(cell.b == 2 && cell.c == 29 && !((cell.a % 4 == 0 && cell.a % 100 != 0) || cell.a % 400 == 0));
                        }
                    }
                    else if (ctrl == 4 && f[0] == 0xD4 && f[1] >= 'A' && f[1] <= 'X')   // a time: D4 hour(letter) m m
                    {
                        const bool pm = f[1] >= 'M';
                        int hr = pm ? f[1] - 'M' : f[1] - 'A';
                        const int hour24 = (pm ? 12 : 0) + hr;
                        if (hr == 0) hr = 12;
                        char t[24];
                        std::snprintf(t, sizeof(t), "%02d:%c%c %s", hr, apple(f[2]), apple(f[3]), pm ? "PM" : "AM");
                        s = t;
                        cell.kind = AdbCell::Time;
                        if (f[2] >= '0' && f[2] <= '5' && f[3] >= '0' && f[3] <= '9') { cell.a = hour24; cell.b = (f[2] - '0') * 10 + (f[3] - '0'); cell.typed = true; }
                    }
                    else
                    {
                        for (unsigned i = 0; i < ctrl; ++i) s += apple(f[i]);
                        cell.kind = AdbCell::Text;
                    }
                    cellBytes += s.size();
                    if (cellBytes > kMaxOutput) return 3;
                    cell.text = std::move(s);
                    q += ctrl;
                    ++col;
                }
                else if (ctrl >= 0x81 && ctrl <= 0x9E)
                {
                    const unsigned skip = ctrl - 0x80;
                    if (col + skip > h.cats) return 3;
                    col += skip;
                }
                else return 3;
            }
            if (out) recs.push_back(std::move(row));
        }
        p = end;
        ++walked;
    }
    if (walked != h.recs + 1) return 3;   // the header's count is of data records, the standard-values record comes first
    if (out)
    {
        // A column is a NUMBER column when every field in it is a canonical decimal (and there is at least one): then its fields are numbers shown with their own
        // decimals. Dates and times are typed one field at a time, from their own markers. Everything else stays text, as stored.
        std::vector<bool> numeric(h.cats, false);
        for (unsigned c = 0; c < h.cats; ++c)
        {
            bool any = false, all = true;
            for (const auto &r : recs)
            {
                const AdbCell &cell = r[c];
                if (cell.kind == AdbCell::Empty) continue;
                unsigned dec;
                if (cell.kind != AdbCell::Text || !adbCanonicalNumber(cell.text, &dec)) { all = false; break; }
                any = true;
            }
            numeric[c] = any && all;
        }
        std::string body;
        bool anyDate = false, anyTime = false;
        unsigned maxDec = 0;
        for (const auto &r : recs)
        {
            body += "<table:table-row>";
            for (unsigned c = 0; c < h.cats; ++c)
            {
                const AdbCell &cell = r[c];
                char buf[48];
                if (cell.kind == AdbCell::Empty) body += "<table:table-cell/>";
                else if (cell.kind == AdbCell::Date && cell.typed)
                {
                    anyDate = true;
                    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d", cell.a, cell.b, cell.c);
                    body += "<table:table-cell table:style-name=\"dt\" office:value-type=\"date\" office:date-value=\""; body += buf; body += "\"><text:p>";
                    xmlText(body, cell.text.data(), cell.text.size()); body += "</text:p></table:table-cell>";
                }
                else if (cell.kind == AdbCell::Time && cell.typed)
                {
                    anyTime = true;
                    std::snprintf(buf, sizeof(buf), "PT%02dH%02dM00S", cell.a, cell.b);
                    body += "<table:table-cell table:style-name=\"tm\" office:value-type=\"time\" office:time-value=\""; body += buf; body += "\"><text:p>";
                    xmlText(body, cell.text.data(), cell.text.size()); body += "</text:p></table:table-cell>";
                }
                else if (numeric[c] && cell.kind == AdbCell::Text)
                {
                    unsigned dec = 0;
                    adbCanonicalNumber(cell.text, &dec);
                    if (dec > maxDec) maxDec = dec;
                    body += "<table:table-cell table:style-name=\"nd" + std::to_string(dec) + "\" office:value-type=\"float\" office:value=\""; body += cell.text; body += "\"><text:p>";
                    body += cell.text; body += "</text:p></table:table-cell>";
                }
                else cellString(body, cell.text.data(), cell.text.size());
            }
            body += "</table:table-row>";
            if (body.size() > kMaxOutput) return 3;
        }
        out->clear();
        *out += kHeadStart;
        if (anyDate)
            *out += "<number:date-style style:name=\"nDt\"><number:day number:style=\"long\"/><number:text>-</number:text><number:month number:textual=\"true\"/><number:text>-</number:text><number:year number:style=\"long\"/></number:date-style>"
                    "<style:style style:name=\"dt\" style:family=\"table-cell\" style:data-style-name=\"nDt\"/>";
        if (anyTime)
            *out += "<number:time-style style:name=\"nTm\"><number:hours number:style=\"long\"/><number:text>:</number:text><number:minutes number:style=\"long\"/><number:text> </number:text><number:am-pm/></number:time-style>"
                    "<style:style style:name=\"tm\" style:family=\"table-cell\" style:data-style-name=\"nTm\"/>";
        for (unsigned k = 0; k <= maxDec; ++k)
        {
            const std::string kk = std::to_string(k);
            *out += "<number:number-style style:name=\"nN" + kk + "\"><number:number number:decimal-places=\"" + kk + "\" number:min-integer-digits=\"1\"/></number:number-style>"
                    "<style:style style:name=\"nd" + kk + "\" style:family=\"table-cell\" style:data-style-name=\"nN" + kk + "\"/>";
        }
        *out += kHeadEnd;
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
