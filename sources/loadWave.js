/*
    DAC - Dynamic Audio Codec, a lossy audio codec written by MINT: https://www.youtube.com/@__MINT_
    
    This file is the input file loader for DAC, comes with absolutely no warranty!
*/

const waveLoaderString = `

self.onmessage = function(event)
 {
 let fileData = event.data;
 let contents = new Uint8Array(fileData.raw);
 let extension = fileData.type;
 function sliceValues(lenData, sliceModes, startByte, bitAt, count)
  {
  let read = [];
  let sliceFrom = contents;
  for(let i=0; i<count; i++)
   {
   let len = lenData[i];
   if(len == 0)
    {
	read.push(0);
    continue;
	}
   let complexSlice = sliceModes[i];
   if(complexSlice)
    {
    let nonZero = sliceFrom[startByte] & (1 << (7 - bitAt));
    bitAt++;
    if(bitAt == 8)
     {
     bitAt = 0;
     startByte++;
     }
    if(!nonZero)
     {
     read.push(0);
     continue;
     }
    }
   let bytes = (bitAt + len + 7) >> 3;
   let sliced = 0;
   let adjust = (bytes << 3) - len - bitAt;
   if(bytes == 1)
    {
    sliced = (sliceFrom[startByte] >> adjust) & ((1 << len) - 1);
    }
   else
    {
    sliced |= sliceFrom[startByte] & (255 >> bitAt);
    if(bytes == 2)
     {
     sliced <<= 8 - adjust;
     sliced |= sliceFrom[startByte + 1] >> adjust;
     }
    else
     {
     sliced <<= 8;
     sliced |= sliceFrom[startByte + 1];
     sliced <<= 8 - adjust;
     sliced |= sliceFrom[startByte + 2] >> adjust;
     }
    }
   if(complexSlice)
    {
    let signCheck = 1 << (len - 1);
    let sign = sliced & signCheck;
    sliced++;
    if(sign)
     {
     sliced = -sliced + signCheck;
     }
    }
   read.push(sliced);
   bitAt += len;
   startByte += bitAt >> 3;
   bitAt &= 7;
   }
  return {values: read, bytePos: startByte, bitPos: bitAt};
  }
 switch(extension)
  {
  case "wav":
   {
   const header = [82, 73, 70, 70, 87, 65, 86, 69, 102, 109, 116, 32, 100, 97, 116, 97];
   const indexes = [0, 1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 36, 37, 38, 39];
   let pointer = 0;
   for(let i of indexes)
    {
    if(contents[i] != header[pointer++])
     {
     postMessage({type: "error", desc: "File is corrupted"});
     return;
     }
    }
   let totalSize = contents[7];
   for(let i=0; i<3; i++)
    {
    totalSize <<= 8;
    totalSize |= contents[6 - i];
    }
   totalSize += 8;
   let channels = (contents[23] << 8) | contents[22];
   let sampling = (contents[26] << 16) | (contents[25] << 8) | contents[24];
   let dataSize = contents[34];
   let dataSectionSize = contents[43];
   for(let i=0; i<3; i++)
    {
    dataSectionSize <<= 8;
    dataSectionSize |= contents[42 - i];
    }
   if(totalSize > 1073741824 || dataSectionSize > 1073741780)
    {
    postMessage({type: "error", desc: "Size over limit (1GB)"});
    return;
    }
   let validSizes = [8, 16, 24];
   if(channels < 1 || channels > 256 || validSizes.indexOf(dataSize) == -1 || sampling < 1000 || sampling > 1000000)
    {
    postMessage({type: "error", desc: "Invalid audio parameters"});
    return;
    }
   dataSize /= 8;
   let totalSamples = parseInt(dataSectionSize / dataSize);
   let points = parseInt(totalSamples / channels);
   let samplePointer = 44;
   let bufferPointer = 0;
   let firstBit = 1 << (dataSize * 8 - 1);
   let audioBuffer = new Int32Array(totalSamples);
   for(let i=0; i<points; i++)
    {
    for(let j=0; j<channels; j++)
     {
     let single = contents[samplePointer + dataSize - 1];
     for(let k=dataSize-2; k>=0; k--)
	  {
	  single <<= 8;
	  single |= contents[samplePointer + k];
	  }
     if(dataSize > 1)
	  {
	  single -= (single & firstBit) << 1;
      }
     audioBuffer[bufferPointer++] = single;
     samplePointer += dataSize;
     }
    }
   let byteLen = contents.length;
   const find = [76, 73, 83, 84];
   let metaFound = false;
   for(let i=0; i<256; i++)
    {
    if(samplePointer + 4 > byteLen)
     {
     break;
     }
    for(let j=0; i<4; j++)
     {
     if(contents[samplePointer + j] != find[j])
      {
	  break;
	  }
     if(j == 3 && samplePointer < byteLen - 21)
      {
	  metaFound = true;
	  }
     }
    if(metaFound)
     {
     samplePointer += 4;
     break;
     }
    samplePointer++;
    }
   let metaContent = new Array(6).fill("");
   if(metaFound)
    {
    let metaLen = contents[samplePointer + 1];
    metaLen <<= 8;
    metaLen |= contents[samplePointer];
    samplePointer += 4;
    let metaEnd = samplePointer + metaLen;
    if(metaEnd > byteLen)
     {
     metaEnd = byteLen;
     metaLen = metaEnd - samplePointer;
     }
    samplePointer += 4;
    const templates = ["INAM", "IART", "IPRD", "IGNR", "ICRD", "ITRK"];
    for(let i=4; i<metaLen; i++)
     {
     let single = "";
     if(i + 8 > metaLen)
      {
	  break;
	  }
     for(let j=0; j<4; j++)
      {
      single += String.fromCharCode(contents[samplePointer++]);
      }
     let singleLen = contents[samplePointer];
     samplePointer += 4;
     i += 8;
     if(i + singleLen > metaLen)
      {
	  break;
	  }
     let property = templates.indexOf(single);
     if(property != -1)
      {
	  let read = "";
	  for(let j=0; j<singleLen; j++)
	   {
	   let readChar = contents[samplePointer + j];
	   if(readChar == 0)
	    {
	    break;
	    }
	   if(readChar > 31 && readChar < 127)
	    {
	    read += String.fromCharCode(readChar);
	    continue;
	    }
	   read += "_";
	   }
	  metaContent[property] = read;
	  }
     i += singleLen - 1;
     samplePointer += singleLen;
     }
    }
   let duration = points / sampling;
   let fileData = {type: "success", audio: audioBuffer.buffer, metaData: metaContent, config: {dSize: dataSize, audioCh: channels, sRate: sampling, tSize: totalSize, sPerCh: points, len: duration}};
   postMessage(fileData, [audioBuffer.buffer]);
   }
  break;
  case "dac":
   {
   let byteSize = contents.length;
   if(byteSize < 20)
    {
    postMessage({type: "error", desc: "Too short file"});
    return;
    }
   if(byteSize > 1073741824)
    {
    postMessage({type: "error", desc: "Size over limit (1GB)"});
    return;
    }
   let totalFileSize = contents[3];
   for(let i=2; i>=0; i--)
    {
    totalFileSize <<= 8;
    totalFileSize |= contents[i];
    }
   if(totalFileSize > byteSize)
    {
    postMessage({type: "error", desc: "File size mismatch"});
    return;
    }
   let framesPerCh = contents[7];
   for(let i=6; i>=4; i--)
    {
    framesPerCh <<= 8;
    framesPerCh |= contents[i];
    }
   if(framesPerCh == 0)
    {
    postMessage({type: "error", desc: "File is corrupted"});
    return;
    }
   let dataWidth = contents[8];
   if(dataWidth < 1 || dataWidth > 3)
    {
    postMessage({type: "error", desc: "Unsupported bit depth"});
    return;
    }
   let subbandSize = contents[9];
   for(let i=4; i<64; i*=2)
    {
    if(subbandSize == i)
     {
     break;
     }
    if(i == 32)
     {
     postMessage({type: "error", desc: "Invalid subband size"});
     return;
     }
    }
   let channels = contents[10] + 1;
   let samplingRate = contents[13];
   for(let i=12; i>=11; i--)
    {
    samplingRate <<= 8;
    samplingRate |= contents[i];
    }
   if(samplingRate < 1000 || samplingRate > 1000000)
    {
    postMessage({type: "error", desc: "Invalid sampling rate"});
    return;
    }
   let keyFramesPerCh = contents[16];
   for(let i=15; i>=14; i--)
    {
    keyFramesPerCh <<= 8;
    keyFramesPerCh |= contents[i];
    }
   if(keyFramesPerCh == 0)
    {
    postMessage({type: "error", desc: "File is corrupted"});
    return;
    }
   let keyFrameInterval = contents[18];
   keyFrameInterval <<= 8;
   keyFrameInterval |= contents[17];
   if(keyFrameInterval == 0)
    {
    postMessage({type: "error", desc: "Invalid key frame spacing"});
    return;
    }
   let metaEndPointer = contents[20];
   metaEndPointer <<= 8;
   metaEndPointer |= contents[19];
   let metaContent = new Array(6).fill("");
   if(metaEndPointer > 25)
    {
	const templates = ["TI", "AR", "AL", "GE", "YE", "TR"];
	let metaPointer = 21;
	while(metaPointer < metaEndPointer)
	 {
	 let prefix = String.fromCharCode(contents[metaPointer]) + String.fromCharCode(contents[metaPointer + 1]);
	 metaPointer += 2;
	 let stringLen = contents[metaPointer++];
	 let metaType = templates.indexOf(prefix);
	 if(metaType != -1)
	  {
	  let single = "";
	  for(let i=0; i<stringLen; i++)
	   {
	   let chrCode = (contents[metaPointer + 1] << 8) | contents[metaPointer];
	   metaPointer += 2;
	   if(chrCode == 0)
	    {
		break;
		}
	   single += String.fromCharCode(chrCode);
	   }
	  metaContent[metaType] = single;
	  continue;
	  }
	 metaPointer += stringLen * 2;
	 }
	}
   let points = framesPerCh * 512;
   let totalSamples = points * channels;
   let totalWaveSize = totalSamples * dataWidth + 44;
   let duration = points / samplingRate;
   let audioBuffer = new Int32Array(totalSamples);
   let keyFramePointers = new Array(keyFramesPerCh);
   let keyFrameCount = 0;
   let dataPointer = metaEndPointer;
   let dataBit = 0;
   let outputPointer = 0;
   let upperLim = tops[dataWidth];
   let bottomLim = bottoms[dataWidth];
   for(let i=0; i<keyFramesPerCh; i++)
    {
    let pointer = contents[dataPointer + 3];
    for(let j=2; j>=0; j--)
     {
     pointer <<= 8;
     pointer |= contents[dataPointer + j];
     }
    keyFramePointers[i] = pointer;
	dataPointer += 4;
	}
   let normalCount = keyFrameInterval;
   let referenceAlloc = [];
   let referenceFactor = [];
   let overlapAdd = [];
   let subbandCount = parseInt(512 / subbandSize);
   for(let i=0; i<channels; i++)
    {
	referenceAlloc.push(new Array(subbandCount));
	referenceFactor.push(new Array(subbandCount));
	overlapAdd.push([new Array(512), new Array(1024)]);
	}
   for(let i=0; i<framesPerCh; i++)
    {
    if(normalCount == keyFrameInterval)
     {
     let frameLoc = keyFramePointers[keyFrameCount++];
	 if(frameLoc > metaEndPointer && frameLoc < byteSize)
	  {
	  dataPointer = frameLoc; // load absolute key frame address
	  dataBit = 0;
	  }
	 for(let j=0; j<channels; j++)
      {
	  let frameBuffer = [];
	  let decodeResult = sliceValues([1, 7], [false, false], dataPointer, dataBit, 2); // decode bitstream (key frame marking bit, number of subbands)
	  let frameBands = decodeResult.values[1];
	  if(frameBands > subbandCount)
	   {
	   frameBands = subbandCount;
	   }
	  let frameCoeffs = frameBands * subbandSize;
	  dataPointer = decodeResult.bytePos;
	  dataBit = decodeResult.bitPos;
	  for(let k=0; k<frameBands; k++)
	   {
	   decodeResult = sliceValues([1, 4, 6], [false, false, false], dataPointer, dataBit, 3); // empty / full bit, direct precision field, direct scalefactor field
	   let absAlloc = decodeResult.values[1] + 1;  // values are stored decremented (zero bit + sign bit + single value bit format is 1, not 2)
	   let absFactor = decodeResult.values[2];
	   dataPointer = decodeResult.bytePos;
	   dataBit = decodeResult.bitPos;
	   referenceAlloc[j][k] = absAlloc; // fill reference arrays
	   referenceFactor[j][k] = absFactor;
	   if(decodeResult.values[0]) // subband is not empty
	    {
		let lenData = new Array(subbandSize).fill(absAlloc);
		let sliceModes = new Array(subbandSize).fill(true);
		decodeResult = sliceValues(lenData, sliceModes, dataPointer, dataBit, subbandSize);
		dataPointer = decodeResult.bytePos;
	    dataBit = decodeResult.bitPos;
		for(let l=0; l<subbandSize; l++)
		 {
		 frameBuffer.push(decodeResult.values[l] * scaleFactorsInv[absFactor]);
		 }
		continue;
		}
	   for(let l=0; l<subbandSize; l++)
		{
		frameBuffer.push(0);
		}
	   }
	  let decodedAudio = FIMDCT(frameBuffer, frameCoeffs);
	  if(i == 0)
	   {
	   overlapAdd[j][0] = decodedAudio.slice(0, 512);
	   }
	  else
	   {
	   overlapAdd[j][0] = overlapAdd[j][1].slice(512, 1024);
	   }
	  overlapAdd[j][1] = decodedAudio;
	  }
     normalCount = 0;
     }
    else
     {
     for(let j=0; j<channels; j++)
      {
	  let frameBuffer = [];
	  let decodeResult = sliceValues([1, 7, 1, 3, 3], [false, false, false, false, false], dataPointer, dataBit, 5);
	  let frameBands = decodeResult.values[1];
	  let nonEmptyUsed = decodeResult.values[2];
	  let allocPrec = decodeResult.values[3];
	  let factorPrec = decodeResult.values[4];
	  if(allocPrec > 5)
	   {
	   allocPrec = 5;
	   }
	  if(frameBands > subbandCount)
	   {
	   frameBands = subbandCount;
	   }
	  let frameCoeffs = frameBands * subbandSize;
	  dataPointer = decodeResult.bytePos;
	  dataBit = decodeResult.bitPos;
	  if(nonEmptyUsed)
	   {
	   for(let k=0; k<frameBands; k++)
	    {
		if(contents[dataPointer] & (1 << (7 - dataBit))) // if non-empty bit is set
	     {
		 decodeResult = sliceValues([1, allocPrec, factorPrec], [false, true, true], dataPointer, dataBit, 3); // allocPrec = 0 or factorPrec = 0  handled
		 dataPointer = decodeResult.bytePos;
	     dataBit = decodeResult.bitPos;
		 let absAlloc = referenceAlloc[j][k] + decodeResult.values[1];
		 let absFactor = referenceFactor[j][k] + decodeResult.values[2];
		 if(absAlloc < 2 || absAlloc > 16)
		  {
		  absAlloc = referenceAlloc[j][k];
		  }
		 else
		  {
		  referenceAlloc[j][k] = absAlloc;
		  }
		 if(absFactor < 0 || absFactor > 63)
		  {
		  absFactor = referenceFactor[j][k];
		  }
		 else
		  {
		  referenceFactor[j][k] = absFactor;
		  }
		 let lenData = new Array(subbandSize).fill(absAlloc);
		 let sliceModes = new Array(subbandSize).fill(true);
		 decodeResult = sliceValues(lenData, sliceModes, dataPointer, dataBit, subbandSize);
		 dataPointer = decodeResult.bytePos;
	     dataBit = decodeResult.bitPos;
		 for(let l=0; l<subbandSize; l++)
		  {
		  frameBuffer.push(decodeResult.values[l] * scaleFactorsInv[absFactor]);
		  }
		 continue;
		 }
		dataBit++;
		dataPointer += dataBit >> 3;
		dataBit &= 7;
		for(let l=0; l<subbandSize; l++)
		 {
		 frameBuffer.push(0);
		 }
		}
	   }
	  else
	   {
	   for(let k=0; k<frameBands; k++)
	    {
	    decodeResult = sliceValues([allocPrec], [true], dataPointer, dataBit, 1); // allocPrec = 0  handled
	    dataPointer = decodeResult.bytePos;
	    dataBit = decodeResult.bitPos;
	    let diffAlloc = decodeResult.values[0];
	    if(allocPrec > 1)
	     {
	     let topAlloc = 1 << (allocPrec - 1);
	     let bottomAlloc = -topAlloc;
		 if(diffAlloc == topAlloc) // empty subband
	      {
		  for(let l=0; l<subbandSize; l++)
		   {
		   frameBuffer.push(0);
		   }
		  continue;
		  }
	     if(diffAlloc == bottomAlloc) // empty subband group
	      {
		  decodeResult = sliceValues([factorPrec + 1], [false], dataPointer, dataBit, 1);
		  dataPointer = decodeResult.bytePos;
	      dataBit = decodeResult.bitPos;
		  let emptySubbands = decodeResult.values[0] + 2;
		  let zeroes = subbandSize * emptySubbands;
		  for(let l=0; l<zeroes; l++)
		   {
		   frameBuffer.push(0);
		   }
		  k += emptySubbands - 1;
		  continue;
		  }
	     }
	    decodeResult = sliceValues([factorPrec], [true], dataPointer, dataBit, 1); // factorPrec = 0  handled
	    dataPointer = decodeResult.bytePos;
	    dataBit = decodeResult.bitPos;
	    let absAlloc = referenceAlloc[j][k] + diffAlloc;
	    let absFactor = referenceFactor[j][k] + decodeResult.values[0];
	    if(absAlloc < 2 || absAlloc > 16)
		 {
		 absAlloc = referenceAlloc[j][k];
		 }
		else
		 {
		 referenceAlloc[j][k] = absAlloc;
		 }
		if(absFactor < 0 || absFactor > 63)
		 {
		 absFactor = referenceFactor[j][k];
		 }
		else
		 {
		 referenceFactor[j][k] = absFactor;
		 }
        let lenData = new Array(subbandSize).fill(absAlloc);
	    let sliceModes = new Array(subbandSize).fill(true);
	    decodeResult = sliceValues(lenData, sliceModes, dataPointer, dataBit, subbandSize);
	    dataPointer = decodeResult.bytePos;
	    dataBit = decodeResult.bitPos;
	    for(let l=0; l<subbandSize; l++)
		 {
		 frameBuffer.push(decodeResult.values[l] * scaleFactorsInv[absFactor]);
		 }
	    }
	   }
	  let decodedAudio = FIMDCT(frameBuffer, frameCoeffs);
	  overlapAdd[j][0] = overlapAdd[j][1].slice(512, 1024);
	  overlapAdd[j][1] = decodedAudio;
	  }
     normalCount++;
     }
    if(i == 0)
     {
     for(let j=0; j<512; j++)
	  {
	  for(let k=0; k<channels; k++)
	   {
	   let single = overlapAdd[k][0][j];
	   if(single > upperLim)
	    {
	    single = upperLim;
	    }
	   else if(single < bottomLim)
	    {
	    single = bottomLim;
	    }
	   audioBuffer[outputPointer++] = single;
	   }
	  }
     continue;
     }
    for(let j=0; j<512; j++)
     {
     for(let k=0; k<channels; k++)
	  {
	  let single = overlapAdd[k][0][j] + overlapAdd[k][1][j];
	  if(single > upperLim)
	   {
	   single = upperLim;
	   }
	  else if(single < bottomLim)
	   {
	   single = bottomLim;
	   }
	  audioBuffer[outputPointer++] = single;
	  }
     }
	}
   let fileData = {type: "success", audio: audioBuffer.buffer, metaData: metaContent, config: {dSize: dataWidth, audioCh: channels, sRate: samplingRate, tSize: totalWaveSize, sPerCh: points, len: duration}};
   postMessage(fileData, [audioBuffer.buffer]);
   }
  break;
  default:
   {
   postMessage({type: "error", desc: "Unsupported file format"});
   return;
   }
  break;
  }
 }`;