__kernel void blur_h2_2560(const int width) {
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  float v = (float)(x + y);
  v += read_imagef(in, sampleri, (int2)(x + 2, y)).x;
  v += read_imagef(in, sampleri, (int2)(x - 2, y)).x;
}
