// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// FF-6 option C (owner decision 2026-11-08): the legacy word-processor module. A legacy file in, flat ODT out, with NO LibreOffice:
// libwpd + libmwaw + libwps -> libodfgen's OdtGenerator. The documents module then renders the flat ODT like any other input.
// It mirrors what writerperfect's three Writer import filters do (same libraries, same generator), minus the dialogs and the embedded WPG graphics.
//
// Contract (read by the worker's pre-step):
//   legacy_convert(data, size) -> 0 ok | 1 not a supported word-processor file | 2 password-protected (declined by design) | 3 parse failed
//   legacy_output()/legacy_output_size() the flat ODT (valid until the next call); legacy_family() "wpd" | "wps" | "mwaw".
// RULES: create a FRESH module instance for every conversion (a hostile file must not be able to leave state behind); the library parsers
// are untrusted-input code, so the caller bounds the time and the memory of an instance.
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <emscripten.h>
#include <librevenge/librevenge.h>
#include <librevenge-stream/librevenge-stream.h>
#include <libodfgen/libodfgen.hxx>
#include <libwpd/libwpd.h>
#include <libmwaw/libmwaw.hxx>
#include <libwps/libwps.h>

namespace
{
std::string g_out;
std::string g_family;

void esc(std::string &o, const char *s, bool attr)
{
    for (; *s; ++s)
    {
        switch (*s)
        {
        case '&': o += "&amp;"; break;
        case '<': o += "&lt;"; break;
        case '>': o += "&gt;"; break;
        case '"': if (attr) o += "&quot;"; else o += '"'; break;
        default: o += *s;
        }
    }
}

class StringHandler : public OdfDocumentHandler
{
public:
    void startDocument() override { g_out += "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"; }
    void endDocument() override {}
    void startElement(const char *name, const librevenge::RVNGPropertyList &props) override
    {
        g_out += '<'; g_out += name;
        librevenge::RVNGPropertyList::Iter i(props);
        for (i.rewind(); i.next();)
        {
            g_out += ' '; g_out += i.key(); g_out += "=\"";
            if (i()) esc(g_out, i()->getStr().cstr(), true);
            g_out += '"';
        }
        g_out += '>';
    }
    void endElement(const char *name) override { g_out += "</"; g_out += name; g_out += '>'; }
    void characters(const librevenge::RVNGString &s) override { esc(g_out, s.cstr(), false); }
};
}

extern "C"
{
// 0 ok, 1 not a supported word-processor file, 2 password-protected (declined by design), 3 parse failed
EMSCRIPTEN_KEEPALIVE int legacy_convert(const unsigned char *data, unsigned size)
{
    g_out.clear(); g_family.clear();
    librevenge::RVNGStringStream input(data, size);

    // libwpd
    libwpd::WPDConfidence wc = libwpd::WPDocument::isFileFormatSupported(&input);
    // libwps
    libwps::WPSKind wkind = libwps::WPS_TEXT; libwps::WPSCreator wcreator = libwps::WPS_MSWORKS; bool needEnc = false;
    libwps::WPSConfidence sc = libwps::WPSDocument::isFileFormatSupported(&input, wkind, wcreator, needEnc);
    // libmwaw
    MWAWDocument::Type mtype = MWAWDocument::MWAW_T_UNKNOWN; MWAWDocument::Kind mkind = MWAWDocument::MWAW_K_UNKNOWN;
    MWAWDocument::Confidence mc = MWAWDocument::isFileFormatSupported(&input, mtype, mkind);

    OdtGenerator gen;
    StringHandler handler;
    gen.addDocumentHandler(&handler, ODF_FLAT_XML);

    if (wc == libwpd::WPD_CONFIDENCE_SUPPORTED_ENCRYPTION || wc == libwpd::WPD_CONFIDENCE_UNSUPPORTED_ENCRYPTION) return 2;
    if (sc == libwps::WPS_CONFIDENCE_SUPPORTED_ENCRYPTION) return 2;
    if (mc == MWAWDocument::MWAW_C_SUPPORTED_ENCRYPTION || mc == MWAWDocument::MWAW_C_UNSUPPORTED_ENCRYPTION) return 2;

    // Which library reads it. LibreOffice runs each filter's own detection in an order its type registration decides; a file with the WordPerfect
    // magic (0xFF 'W' 'P' 'C') is WordPerfect, and otherwise the strong detectors (libwps, libmwaw) come before libwpd's weak heuristics for
    // pre-WPC files (a DOS Works file can look like WordPerfect 4.2).
    const bool wpcMagic = size >= 4 && data[0] == 0xff && data[1] == 'W' && data[2] == 'P' && data[3] == 'C';
    const bool useWpd = wc == libwpd::WPD_CONFIDENCE_EXCELLENT && (wpcMagic || (sc != libwps::WPS_CONFIDENCE_EXCELLENT && mc != MWAWDocument::MWAW_C_EXCELLENT));
    if (useWpd)
    {
        g_family = "wpd";
        return libwpd::WPD_OK == libwpd::WPDocument::parse(&input, &gen, nullptr) ? 0 : 3;
    }
    if (sc == libwps::WPS_CONFIDENCE_EXCELLENT && wkind == libwps::WPS_TEXT)
    {
        g_family = "wps";
        const char *enc = "";
        if (needEnc) enc = (wcreator == libwps::WPS_RESERVED_0) ? "CP1252" : "CP850";   // the code pages the LibreOffice dialog proposes
        return libwps::WPS_OK == libwps::WPSDocument::parse(&input, &gen, "", enc) ? 0 : 3;
    }
    if (mc == MWAWDocument::MWAW_C_EXCELLENT && mkind == MWAWDocument::MWAW_K_TEXT)
    {
        g_family = "mwaw";
        return MWAWDocument::MWAW_R_OK == MWAWDocument::parse(&input, &gen) ? 0 : 3;
    }
    return 1;
}
EMSCRIPTEN_KEEPALIVE const char *legacy_output() { return g_out.data(); }
EMSCRIPTEN_KEEPALIVE unsigned legacy_output_size() { return unsigned(g_out.size()); }
EMSCRIPTEN_KEEPALIVE const char *legacy_family() { return g_family.c_str(); }
EMSCRIPTEN_KEEPALIVE unsigned char *legacy_alloc(unsigned n) { return static_cast<unsigned char *>(malloc(n)); }
EMSCRIPTEN_KEEPALIVE void legacy_free(unsigned char *p) { free(p); }
}
