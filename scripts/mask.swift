// Cuts the pet out of each frame with Apple Vision's subject lifting (the
// cut-out you get by long-pressing a photo), for make-pet.ts on macOS.
//
//   swift mask.swift <frames folder> <masks folder>
//
// For every PNG in <frames folder>, writes a grayscale PNG of the same name
// and size to <masks folder>: white for the pet, black for the rest. Unlike
// keying out the white, it knows a white marking from a gap and leaves out
// the floor shadow. It runs on the Neural Engine. Exits non-zero if any frame
// failed, so make-pet.ts can fall back to keying the white.
import CoreImage
import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write(Data("usage: swift mask.swift <frames folder> <masks folder>\n".utf8))
  exit(2)
}
let input = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let context = CIContext()
let gray = CGColorSpaceCreateDeviceGray()
let names = try FileManager.default.contentsOfDirectory(atPath: input.path).filter { $0.hasSuffix(".png") }.sorted()
var failed = 0
for name in names {
  let target = output.appendingPathComponent(name)
  guard let source = CGImageSourceCreateWithURL(input.appendingPathComponent(name) as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    FileHandle.standardError.write(Data("\(name): unreadable\n".utf8))
    failed += 1
    continue
  }
  let request = VNGenerateForegroundInstanceMaskRequest()
  let handler = VNImageRequestHandler(cgImage: image)
  do {
    try handler.perform([request])
    if let result = request.results?.first {
      let buffer = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
      try context.writePNGRepresentation(of: CIImage(cvPixelBuffer: buffer), to: target, format: .L8, colorSpace: gray)
    } else {
      // No subject in the frame: nothing of it to keep.
      let none = CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      try context.writePNGRepresentation(of: none, to: target, format: .L8, colorSpace: gray)
    }
  } catch {
    FileHandle.standardError.write(Data("\(name): \(error.localizedDescription)\n".utf8))
    failed += 1
  }
}
exit(failed == 0 ? 0 : 1)
